import { getOsmFeatureName, type ChangesetFeature } from "facilmap-utils";
import { getI18n } from "../../../utils/i18n";
import type { OsmFeatureType } from "osm-api";

export function getOsmObjectLabel(type: OsmFeatureType, id: number): string {
	const i18n = getI18n();
	const typeLabel = (
		type === "node" ? i18n.t("changeset-results.osm-node") :
		type === "way" ? i18n.t("changeset-results.osm-way") :
		type === "relation" ? i18n.t("changeset-results.osm-relation") :
		""
	);
	return `${typeLabel ? `${typeLabel} ` : ""}${id}`;
}

export function getChangesetFeatureLabel(feature: ChangesetFeature): string {
	const i18n = getI18n();
	const oldName = getOsmFeatureName(feature.old?.tags ?? {}, i18n.currentLanguage);
	const newName = getOsmFeatureName(feature.new?.tags ?? {}, i18n.currentLanguage);
	const name = oldName && newName && oldName !== newName ? `${oldName} → ${newName}` : (oldName ?? newName);
	const label = getOsmObjectLabel(feature.type, feature.id);
	return `${label}${name ? ` (${name})` : ""}`;
}