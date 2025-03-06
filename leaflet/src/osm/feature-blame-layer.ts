import type { Colour, Point, Shape } from "facilmap-types";
import { FeatureGroup, Layer, type LayerOptions, type PathOptions } from "leaflet";
import MarkerLayer from "../markers/marker-layer";
import type { AnalyzedChangeset, ChangesetFeature } from "facilmap-utils";
import { HighlightablePolyline } from "leaflet-highlightable-layers";

declare module "leaflet" {
	interface Layer {
		_fmChangesetFeature?: ChangesetFeature;
	}
}

function getFeatureKey(feature: ChangesetFeature | string): string {
	return typeof feature === "string" ? feature : `${feature.type}-${feature.id}`;
}

export interface ChangesetLayerOptions extends LayerOptions {
	deletedColour?: Colour;
	createdColour?: Colour;
	unchangedColour?: Colour;
	markerSize?: number;
	markerShape?: Shape;
	pathOptions?: PathOptions;
}

export default class ChangesetLayer extends FeatureGroup {

	declare options: ChangesetLayerOptions;
	highlightedFeatures = new Set<string>();

	constructor(changeset?: AnalyzedChangeset, options?: ChangesetLayerOptions) {
		super([], {
			deletedColour: "ff0000",
			createdColour: "00ff00",
			unchangedColour: "0000ff",
			markerSize: 15,
			markerShape: "",
			...options
		});

		if (changeset)
			this.setChangeset(changeset);
	}

	highlightFeature(feature: ChangesetFeature | string): void {
		this.highlightedFeatures.add(getFeatureKey(feature));
		this.redrawFeature(feature);
	}

	unhighlightFeature(feature: ChangesetFeature | string): void {
		this.highlightedFeatures.delete(getFeatureKey(feature));
		this.redrawFeature(feature);
	}

	setHighlightedFeatures(features: Set<ChangesetFeature>): void {
		const keys = new Set([...features].map((f) => getFeatureKey(f)));
		for (const feature of this.highlightedFeatures) {
			if (!keys.has(getFeatureKey(feature)))
				this.unhighlightFeature(feature);
		}

		for (const key of keys) {
			if (!this.highlightedFeatures.has(key))
				this.highlightFeature(key);
		}
	}

	redrawFeature(feature: ChangesetFeature | string): void {
		const key = getFeatureKey(feature);

		// We always highlight all layers of an OSM feature at once (for example the old and new version of a marker).
		// The feature key of two layers is the same if they refer to the same type and ID, but their feature object might be
		// different, for example if they refer to different versions of the same object.
		const layerGroups = new Map<ChangesetFeature, Layer[]>();
		for (const layer of this.getLayers()) {
			if (layer._fmChangesetFeature && getFeatureKey(layer._fmChangesetFeature) === key) {
				let group = layerGroups.get(layer._fmChangesetFeature);
				if (!group) {
					layerGroups.set(layer._fmChangesetFeature, group = []);
				}
				group.push(layer);
			}
		}

		for (const [feature, layers] of layerGroups) {
			for (const layer of layers) {
				this.removeLayer(layer);
			}

			for (const layer of this.featureToLayers(feature)) {
				this.addLayer(layer);
			}
		}
	}

	createNodeLayer(point: Point, colour: Colour, highlight: boolean): Layer {
		return new MarkerLayer([point.lat, point.lon], {
			marker: { colour, size: this.options.markerSize!, icon: "", shape: "circle" },
			highlight,
			raised: highlight
		})
	}

	createWayLayer(path: Point[], colour: Colour, highlight: boolean): Layer {
		return new HighlightablePolyline(path.map((p) => [p.lat, p.lon]), {
			color: `#${colour}`,
			raised: highlight,
			opacity: highlight ? 1 : 0.35,
			...this.options.pathOptions
		});
	}

	featureToLayers(feature: ChangesetFeature): Layer[] {
		const highlight = this.highlightedFeatures.has(getFeatureKey(feature));

		let layers: Layer[];
		if (feature.type === "node") {
			if (feature.old && feature.new && feature.old.lat === feature.new.lat && feature.old.lon === feature.new.lon) {
				layers = [this.createNodeLayer(feature.new, this.options.unchangedColour!, highlight)];
			} else {
				layers = [
					...feature.old ? [this.createNodeLayer(feature.old, this.options.deletedColour!, highlight)] : [],
					...feature.new ? [this.createNodeLayer(feature.new, this.options.createdColour!, highlight)] : []
				];
			}
		} else if (feature.type === "way") {
			layers = [
				...feature.unchanged.map((path) => this.createWayLayer(path, this.options.unchangedColour!, highlight)),
				...feature.deleted.map((path) => this.createWayLayer(path, this.options.deletedColour!, highlight)),
				...feature.created.map((path) => this.createWayLayer(path, this.options.createdColour!, highlight))
			];
		} else {
			layers = [];
		}

		for (const layer of layers) {
			layer._fmChangesetFeature = feature;
		}

		return layers;
	}

	setChangeset(changeset: AnalyzedChangeset | undefined): void {
		this.clearLayers();

		if (changeset) {
			for (const feature of changeset.features) {
				for (const layer of this.featureToLayers(feature)) {
					this.addLayer(layer);
				}
			}
		}
	}

}
