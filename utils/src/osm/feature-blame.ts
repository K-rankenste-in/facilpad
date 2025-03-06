import * as OSM from "osm-api";
import { scaleProgress, sendProgress, generateUniqueColours, type OnProgress } from "../utils";
import type { Bbox } from "facilmap-types";
import { memoize, orderBy, uniqBy } from "lodash-es";
import { getBboxForNodeList, getFeatureAtTimestamp, getFeatureKey, nodeListToSegments } from "./utils";

export type OsmFeatureBlame = {
	feature: OSM.OsmRelation | OSM.OsmWay;
	/**
	 * A segment represents a path of nodes or a single node that is a (direct or indirect) member of the relation/way.
	 * One segment in this array represents a continuous piece of path that ended up in the relation through a single changeset.
	 */
	segments: Array<{
		/**
		 * A segment can be added to a relation in the following ways:
		 * - A node somewhere in the hierarchy of relations and ways is moved
		 * - A node, way or relation is added to a way or relation in the hierarchy of relations and ways
		 * This property contains the specific revisions of the specific nodes/ways/relations that caused the current segment to be
		 * in the relation.
		 */
		causingChanges: Array<{
			feature: OSM.OsmFeature;
			featureMembership: Array<{ feature: OSM.OsmRelation | OSM.OsmWay; role?: string }>;
		}>;
		path: OSM.OsmNode[];
		user: string;
		changeset: number;
		timestamp: string;
	}>;
	users: Record<string, {
		colour: string;
	}>;
}

type FeatureSegment = {
	a: OSM.OsmNode;
	b: OSM.OsmNode;

	membership: Array<{
		feature: OSM.OsmRelation | OSM.OsmWay;
		role?: string;
	}>;
};

function getSegmentKey(segment: FeatureSegment): string {
	return `${segment.a.lat},${segment.a.lon};${segment.b.lat},${segment.b.lon}`;
}

export async function blameOsmFeature(type: "relation" | "way", id: number, onProgress?: OnProgress & { onBbox?: (bbox: Bbox) => void }): Promise<OsmFeatureBlame> {
	const getFeatureHistory = memoize((type: OSM.OsmFeatureType, id: number) => OSM.getFeatureHistory(type, id), (type, id) => `${type}-${id}`) as typeof OSM.getFeatureHistory;

	async function getRecursiveSegmentsAtTimestamp(thisType: "relation" | "way", thisId: number, date: Date | undefined, _membership: FeatureSegment["membership"] = []): Promise<{ feature: OSM.OsmWay | OSM.OsmRelation; features: OSM.OsmFeature[]; segments: FeatureSegment[] }> {
		const mainFeature = getFeatureAtTimestamp(await getFeatureHistory(thisType, thisId), date)!;
		const features: OSM.OsmFeature[] = [];
		const segments: FeatureSegment[] = [];

		const handleWay = async (way: OSM.OsmWay, membership: FeatureSegment["membership"]) => {
			const nodes: OSM.OsmNode[] = [];
			for (const nodeId of way.nodes) {
				const node = getFeatureAtTimestamp(await getFeatureHistory("node", nodeId), date);
				if (node) {
					nodes.push(node);
					features.push(node);
				}
			}
			let wayMembership = [...membership, { feature: way }];
			segments.push(...nodeListToSegments(nodes).map(([a, b]) => ({ a, b, membership: wayMembership })));
		};

		if (mainFeature?.type === "way") {
			await handleWay(mainFeature, _membership);
		} else if (mainFeature?.type === "relation") {
			for (const member of mainFeature.members) {
				const membership = [..._membership, { feature: mainFeature, role: member.role }];
				if (member.type === "relation") {
					if (!membership.some((m) => m.feature.type === member.type && m.feature.id === member.ref)) { // Avoid recursion
						const recursive = await getRecursiveSegmentsAtTimestamp(member.type, member.ref, date, membership);
						features.push(recursive.feature, ...recursive.features);
						segments.push(...recursive.segments);
					}
				} else {
					const feature = getFeatureAtTimestamp(await getFeatureHistory(member.type, member.ref), date);
					if (feature) {
						features.push(feature);

						if (feature.type === "node") {
							segments.push({ a: feature, b: feature, membership });
						} else if (feature.type === "way") {
							await handleWay(feature, membership);
						}
					}
				}
			}
		}
		return { feature: mainFeature, features, segments };
	}

	let data = await getRecursiveSegmentsAtTimestamp(type, id, undefined);
	let rawSegments = new Map<string, FeatureSegment>();
	let date: number | undefined = undefined;

	sendProgress(onProgress, 0.1);
	onProgress?.onBbox?.(getBboxForNodeList(data.segments.flatMap((s) => [s.a, s.b])));

	while (date == null || date > -Infinity) {
		data = await getRecursiveSegmentsAtTimestamp(type, id, date != null ? new Date(date) : undefined);

		if (date == null) {
			// First iteration
			rawSegments = new Map(data.segments.map((s) => [getSegmentKey(s), s]));
			date = Math.max(...[data.feature, ...data.features].map((f) => new Date(f.timestamp).getTime()));
		} else {
			let handled = 0;
			for (const segment of data.segments) {
				const key = getSegmentKey(segment);
				if (rawSegments.has(key)) {
					handled++;
					rawSegments.set(key, segment);
				}
			}

			sendProgress(scaleProgress(onProgress, 0.1, 1), 1 - (handled / rawSegments.size));

			if (handled === 0) {
				// This version of the relation has no common segments with the latest version, so we are finished.
				break;
			}
		}

		date = Math.max(...[data.feature, ...data.features].map((f) => new Date(f.timestamp).getTime()).filter((d) => d < date!));
	}

	// Combine way segments (individual nodes stay individual) that are part of the same changeset
	const basicSegments: Array<Pick<OsmFeatureBlame["segments"][number], "causingChanges" | "path">> = [];
	let currentChangeset: number | undefined;
	let currentSegment: typeof basicSegments[number] | undefined;
	for (const segment of rawSegments.values()) {
		const latest = orderBy([
			...segment.membership.map((m, i) => ({ feature: m.feature, featureMembership: segment.membership.slice(0, i) })),
			{ feature: segment.a, featureMembership: segment.membership },
			{ feature: segment.b, featureMembership: segment.membership },
		], (m) => m.feature.timestamp)[0];
		const isIndividualNode = segment.membership[segment.membership.length - 1]?.feature.type !== "way";

		if (currentChangeset == null || isIndividualNode || latest.feature.changeset !== currentChangeset) {
			currentChangeset = isIndividualNode ? undefined : latest.feature.changeset;
			currentSegment = {
				causingChanges: [],
				path: [segment.a]
			};
			basicSegments.push(currentSegment);
		}

		currentSegment!.causingChanges.push(latest);

		if (!isIndividualNode) {
			currentSegment!.path.push(segment.b);
		}
	}

	const segments = basicSegments.map((segment) => {
		const ordered = orderBy(segment.causingChanges, (c) => c.feature.timestamp, "desc");
		return {
			path: segment.path,
			causingChanges: uniqBy(ordered, (c) => getFeatureKey(c.feature)),
			user: ordered[0].feature.user,
			changeset: ordered[0].feature.changeset,
			timestamp: ordered[0].feature.timestamp
		};
	});

	const userIds = new Set(segments.map((s) => s.user));
	const users: OsmFeatureBlame["users"] = {};
	const colourGen = generateUniqueColours();
	for (const userId of userIds) {
		users[userId] = {
			colour: colourGen.next().value!
		};
	}

	return { feature: data.feature, segments, users };
}