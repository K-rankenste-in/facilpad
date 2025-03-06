import type { Bbox, Colour, Point } from "facilmap-types";
import { groupBy, orderBy, sortBy } from "lodash-es";
import * as OSM from "osm-api";
import { sendProgress, type OnProgress } from "../utils";

export function getFeatureKey(feature: OSM.OsmFeature): string {
	return `${feature.type}-${feature.id}`;
}

/**
 * Fetches the content of a changeset and removes double entries.
 * You can do very funny things in a changeset. You can create an object, modify it multiple times and then remove
 * it again, so that basically, you haven’t created nor modified nor removed anything in the changeset, because
 * afterwards everything is as it was.
 * This function cleans up such multiple entries considering the same object by doing the following things:
 * 1. If an object was modified multiple times in one changeset, keep only the newest modification in the “modify” block
 * 2. If an object has been created and later modified in one changeset, move the newest modification to the “create” block
 * 3. If an object has been modified and later removed in one changeset, remove the part from the “modify” block
 * 4. If an object has been created and later removed in one changset, remove it from both the “create” and the “delete” part
 * @throws APIError There was an error communicating with the API
 */
export async function getFixedChangesetDiff(diff: OSM.OsmChange, onProgress?: OnProgress): Promise<OSM.OsmChange> {
	const createdIds = new Set(diff.create.map((f) => `${f.type}-${f.id}`));
	const deletedIds = new Set(diff.delete.map((f) => `${f.type}-${f.id}`));

	// If an object has been created and then deleted in one changeset, remove it from both blocks
	// If an object has been modified and then deleted in one changeset, remove it from the “modify” block
	const created = diff.create.filter((f) => !deletedIds.has(`${f.type}-${f.id}`));
	const modified = diff.modify.filter((f) => !deletedIds.has(`${f.type}-${f.id}`));
	const deletedRaw = diff.delete.filter((f) => !createdIds.has(`${f.type}-${f.id}`));

	// Deleted items are not fully contained in changeset, we need to download them manually
	const deleted: OSM.OsmFeature[] = [];
	for (let i = 0; i < deletedRaw.length; i++) {
		const feature = deletedRaw[i];
		deleted.push(await OSM.getFeatureAtVersion(feature.type, feature.id, feature.version - 1));
		sendProgress(onProgress, (i + 1) / deletedRaw.length);
	}

	for (let i = 0; i < modified.length; i++) {
		const feature = modified[i];

		// If an object has been created and then modified in one changeset, move the modified one to the “create” block
		const createdIdx = created.findIndex((f) => f.id === feature.id);
		if (createdIdx !== -1) {
			created[createdIdx] = feature;
			modified.splice(i--, 1);
			continue;
		}

		// If an object has been modified multiple times in one changeset, only keep the newest one
		if (modified.some((f) => f.id === feature.id && f.version > feature.version)) {
			modified.splice(i--, 1);
			continue;
		}
	}

	return { create: created, modify: modified, delete: deleted };
}

/**
 * Returns the last accessible version before the changeset for each of the provided features.
 * @param modified The (unfixed) list of modified features of the changeset. Each feature may appear multiple times in the changeset. The previous
 *     version of the lowest version number of each feature is returned.
 */
export async function getPreviousVersions(modified: OSM.OsmFeature[], onProgress?: OnProgress): Promise<Map<OSM.OsmFeature, OSM.OsmFeature>> {
	const result = new Map<OSM.OsmFeature, OSM.OsmFeature>();
	const grouped = Object.values(groupBy(modified, (f) => `${f.type}-${f.id}`));
	for (let i = 0; i < grouped.length; i++) {
		const features = grouped[i];
		const sorted = sortBy(features, "version");
		const first = sorted[0];
		const last = sorted[sorted.length - 1];

		for (let version = first.version - 1; version >= 1; version--) {
			try {
				const oldVersion = await OSM.getFeatureAtVersion(last.type, last.id, version);
				for (const feature of features) {
					result.set(feature, oldVersion);
				}
				break;
			} catch (err: any) {
				// Since the OSMF License Redaction, there are some versions that are inaccessable and return a status code of 403
				if (err.cause !== 403 && err.cause !== 404) {
					throw err;
				}
			}
		}

		sendProgress(onProgress, (i + 1) / grouped.length);
	}
	return result;
}

export function getFeatureAtTimestamp<T extends OSM.OsmFeature>(history: T[], date: Date | undefined): T | undefined {
	const ordered = orderBy(history, "timestamp", "desc");
	return date ? ordered.find((f) => new Date(f.timestamp) <= date) : ordered[0];
}

export type NodeListSegment = [OSM.OsmNode, OSM.OsmNode];

export function nodeListToSegments(nodes: OSM.OsmNode[]): NodeListSegment[] {
	const result: NodeListSegment[] = [];
	for (let i = 1; i < nodes.length; i++) {
		result.push([nodes[i-1], nodes[i]]);
	}
	return result;
}

export function segmentsToMultiPolyline(segments: NodeListSegment[]): Point[][] {
	const result: Point[][] = [];
	let currentLine: Point[] | undefined;
	let lastPoint: OSM.OsmNode | undefined;
	for (const segment of segments) {
		if (currentLine == null || lastPoint == null || lastPoint.id !== segment[0].id) {
			currentLine = [segment[0]];
			result.push(currentLine);
		}
		currentLine.push(segment[1]);
		lastPoint = segment[1];
	}
	return result;
}

async function _getRelationRecursive(relationId: number, _handled: Set<number>): Promise<OSM.OsmFeature[]> {
	const features = await OSM.getFeature("relation", relationId, true);
	for (const feature of features) {
		if (feature.type === "relation" && !_handled.has(relationId)) {
			features.push(...await _getRelationRecursive(relationId, _handled));
		}
	}
	return features;
}

export async function getRelationRecursive(relationId: number): Promise<{ relation: OSM.OsmRelation; features: OSM.OsmFeature[] }> {
	const features = await _getRelationRecursive(relationId, new Set<number>());

	// Drop duplicates
	const featureMap = new Map(features.map((f) => [`${f.type}-${f.id}`, f]));
	return {
		relation: featureMap.get(`relation-${relationId}`) as OSM.OsmRelation,
		features: [...featureMap.values()]
	};
}

export function getBboxForNodeList(nodes: Point[]): Bbox {
	const allLats = nodes.map((n) => n.lat);
	const allLons = nodes.map((n) => n.lon);

	return {
		bottom: Math.min(...allLats),
		top: Math.max(...allLats),
		left: Math.min(...allLons),
		right: Math.max(...allLons)
	};
}