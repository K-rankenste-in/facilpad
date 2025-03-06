import { intersectionBy, memoize, pullAllBy } from "lodash-es";
import { getBboxForNodeList, getFeatureAtTimestamp, getFixedChangesetDiff, getPreviousVersions, nodeListToSegments, segmentsToMultiPolyline, type NodeListSegment } from "./utils";
import * as OSM from "osm-api";
import type { DistributedPick } from "../types";
import type { Bbox, Point } from "facilmap-types";
import { scaleProgress, sendProgress, type OnProgress } from "../utils";

export type ChangesetFeature = {
	[T in OSM.OsmFeatureType]: {
		type: T;
		id: number;
	} & (
		{ old: OSM.UtilFeatureForType<T>; new: undefined }
		| { old: undefined; new: OSM.UtilFeatureForType<T> }
		| { old: OSM.UtilFeatureForType<T>; new: OSM.UtilFeatureForType<T> }
	) & (T extends "way" ? {
		deleted: Point[][];
		created: Point[][];
		unchanged: Point[][];
	} : {})
}[OSM.OsmFeatureType];

export type AnalyzedChangeset = {
	changeset: OSM.Changeset;
	features: ChangesetFeature[];
};

export async function analyzeChangeset(changesetId: number, onProgress?: OnProgress & { onBbox?: (bbox: Bbox) => void }): Promise<AnalyzedChangeset> {
	const nodeHistory = memoize((nodeId: number) => OSM.getFeatureHistory("node", nodeId));
	const wayHistory = memoize((wayId: number) => OSM.getFeatureHistory("way", wayId));

	const changeset = await OSM.getChangeset(changesetId);

	// Some old changesets (for example 123456) seem to have no bbox
	const hasBbox = changeset.min_lat != null && changeset.min_lon != null && changeset.max_lat != null && changeset.max_lon != null;
	if (hasBbox) {
		onProgress?.onBbox?.({ top: changeset.max_lat, left: changeset.min_lon, bottom: changeset.min_lat, right: changeset.max_lon });
	}

	const timeBefore = new Date(changeset.created_at.getTime() - 1);
	sendProgress(onProgress, 0.01);
	const rawDiff = await OSM.getChangesetDiff(changesetId);
	sendProgress(onProgress, 0.02);
	const diff = await getFixedChangesetDiff(rawDiff, scaleProgress(onProgress, 0.02, 0.1));
	/** Each feature that was modified by the changeset mapped to its previous version */
	const prev = await getPreviousVersions(rawDiff.modify, scaleProgress(onProgress, 0.1, 0.4));

	/** The old and new version of all modified nodes */
	const modifiedNodesOldAndNew = diff.modify.flatMap((f) => {
		const old = f.type === "node" && prev.get(f);
		return old && old.type === "node" ? [[old, f] as const] : [];
	});
	/** All removed nodes and the old versions of all modified nodes */
	const oldNodes = new Map<number, OSM.OsmNode>([
		...diff.delete.flatMap((f) => f.type === "node" ? [[f.id, f] as const] : []),
		...modifiedNodesOldAndNew.map(([o, n]) => [o.id, o] as const)
	]);
	/** All created nodes and the new versions of all modified nodes */
	const newNodes = new Map<number, OSM.OsmNode>([
		...diff.create.flatMap((f) => f.type === "node" ? [[f.id, f] as const] : []),
		...modifiedNodesOldAndNew.map(([o, n]) => [n.id, n] as const)
	]);

	// If only one node is moved in a changeset, that node might be a member of one or more
	// ways and thus change these. As there is no real way to find out the parent ways
	// of a node at the time of the changeset, we can only check the historic versions of their
	// current parent ways.

	/** The IDs of all modified ways */
	const modifiedWayIds = new Set(diff.modify.flatMap((f) => f.type === "way" ? [f.id] : []));
	/**
	 * The ways that were implicitly changed by the changeset (some of their nodes were moved)
	 * without being explicitly changed by the changeset. In their latest version before the changeset.
	 */
	const waysChanged = new Map<number, OSM.OsmWay>();
	const movedNodesNew = modifiedNodesOldAndNew.flatMap(([o, n]) => o.lat !== n.lat || o.lon !== n.lon ? [n] : []);
	for (let i = 0; i < movedNodesNew.length; i++) {
		const node  = movedNodesNew[i];
		for (const way of await OSM.getWaysForNode(node.id)) {
			if (waysChanged.has(way.id) || modifiedWayIds.has(way.id)) {
				continue;
			}

			const history = await wayHistory(way.id);
			const last = getFeatureAtTimestamp(history, timeBefore);
			if (last?.nodes.includes(node.id)) {
				waysChanged.set(last.id, last);
			}
		}
		sendProgress(scaleProgress(onProgress, 0.4, 0.7), (i + 1) / movedNodesNew.length);
	}

	const rawFeatures: Array<DistributedPick<ChangesetFeature, "type" | "id" | "old" | "new">> = [
		...diff.modify.map((f) => ({ type: f.type, id: f.id, old: prev.get(f), new: f })),
		...Object.values(waysChanged).map((f) => ({ type: f.type, id: f.id, old: f, new: f })),
		...diff.create.map((f) => ({ type: f.type, id: f.id, old: undefined, new: f })),
		...diff.delete.map((f) => ({ type: f.type, id: f.id, old: f, new: undefined }))
	];

	// Now make an array of node arrays to represent the old and the new form of the changed way
	const getSegments = async (way: OSM.OsmWay, time: Date, nodesMap: Map<number, OSM.OsmNode>) => {
		const nodes: OSM.OsmNode[] = [];
		for (const nodeId of way.nodes) {
			nodes.push(nodesMap.has(nodeId) ? nodesMap.get(nodeId)! : getFeatureAtTimestamp(await nodeHistory(nodeId), time)!);
		}
		return nodeListToSegments(nodes);
	};

	let features: ChangesetFeature[] = [];
	const wayFeaturesTotal = rawFeatures.filter((f) => f.type === "way").length;
	let wayFeaturesHandled = 0;
	let nodesPartOfWays = new Set<number>();
	for (const feature of rawFeatures) {
		if (feature.type !== "way") {
			features.push(feature);
			continue;
		}

		const deletedSegments = feature.old ? await getSegments(feature.old, timeBefore, oldNodes) : [];
		const createdSegments = feature.new ? await getSegments(feature.new, changeset.closed_at, newNodes) : [];

		for (const node of [...deletedSegments, ...createdSegments].flatMap((s) => s)) {
			nodesPartOfWays.add(node.id);
		}

		const getSegmentKey = (s: NodeListSegment) => `${s[0].lat},${s[0].lon};${s[1].lat},${s[1].lon}`;
		const unchangedSegments = intersectionBy(deletedSegments, createdSegments, getSegmentKey);
		pullAllBy(deletedSegments, unchangedSegments, getSegmentKey);
		pullAllBy(createdSegments, unchangedSegments, getSegmentKey);

		features.push({
			...feature,
			deleted: segmentsToMultiPolyline(deletedSegments),
			created: segmentsToMultiPolyline(createdSegments),
			unchanged: segmentsToMultiPolyline(unchangedSegments)
		});

		sendProgress(scaleProgress(onProgress, 0.7, 1), (++wayFeaturesHandled) / wayFeaturesTotal);
	}

	// Only keep node features if either they have tags or they are not part of any changed way
	features = features.filter((feature) => {
		if (feature.type === "node") {
			return (Object.keys(feature.old?.tags ?? {}).length > 0 || Object.keys(feature.new?.tags ?? {}).length > 0) || !nodesPartOfWays.has((feature.old ?? feature.new).id);
		} else {
			return true;
		}
	});

	if (!hasBbox) {
		const bbox = getBboxForNodeList(features.flatMap((f) => {
			if (f.type === "node") {
				return [...f.old ? [f.old] : [], ...f.new ? [f.new] : []];
			} else if (f.type === "way") {
				return [...f.deleted, ...f.created, ...f.unchanged].flat();
			} else {
				return [];
			}
		}));

		changeset.min_lat = bbox.bottom;
		changeset.max_lat = bbox.top;
		changeset.min_lon = bbox.left;
		changeset.max_lon = bbox.right;

		onProgress?.onBbox?.(bbox);
	}

	return { changeset, features };
}