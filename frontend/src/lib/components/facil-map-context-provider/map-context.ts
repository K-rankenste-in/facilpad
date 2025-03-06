import type { BboxHandler, HashHandler, HashQuery, LinesLayer, MarkersLayer, OverpassLayer, OverpassPreset, SearchResultsLayer, VisibleLayers } from "facilmap-leaflet";
import type { LatLng, LatLngBounds, Map } from "leaflet";
import type { FilterFunc } from "facilmap-utils";
import type { Emitter } from "mitt";
import type { DeepReadonly } from "vue";
import type { SelectedItem } from "../../utils/selection";
import type SelectionHandler from "../../utils/selection";
import type { AttributionControl } from "../leaflet-map/attribution";
import type { Point } from "facilmap-types";
import type ChangesetLayer from "facilmap-leaflet";

export type MapContextEvents = {
	"open-selection": { selection: DeepReadonly<SelectedItem[]> };
};

export interface MapComponents {
	zoomControl: L.Control.Zoom;
	attribution: AttributionControl;
	bboxHandler: BboxHandler;
	container: HTMLElement;
	graphicScale: any;
	hashHandler: HashHandler & { _fmActivate: () => Promise<void> };
	linesLayer: LinesLayer;
	locateControl?: L.Control.Locate;
	map: Map;
	markersLayer: MarkersLayer;
	mousePosition: L.Control.MousePosition;
	overpassLayer: OverpassLayer;
	searchResultsLayer: SearchResultsLayer;
	changesetLayer: ChangesetLayer;
	selectionHandler: SelectionHandler;
}

export type MapContextData = {
	center: LatLng;
	zoom: number;
	bounds: LatLngBounds;
	layers: VisibleLayers;
	filter: string | undefined;
	filterFunc: FilterFunc;
	hash: string;
	showToolbox: boolean;
	selection: DeepReadonly<SelectedItem>[];
	activeQuery: HashQuery | undefined;
	fallbackQuery: HashQuery | undefined;
	setFallbackQuery: (query: HashQuery | undefined) => void;
	interaction: boolean;
	loading: number;
	overpassIsCustom: boolean;
	overpassPresets: OverpassPreset[];
	overpassCustom: string;
	overpassMessage: string | undefined;
	location: Point | undefined;
	components: MapComponents;
	loaded: boolean;
	fatalError: string | undefined;
	/** Increase mapContext.loading while the given async function is running. */
	runOperation: <R>(operation: () => Promise<R>) => Promise<R>;
};

export type WritableMapContext = MapContextData & Emitter<MapContextEvents>;

export type MapContext = DeepReadonly<Omit<WritableMapContext, "components">> & {
	readonly components: Readonly<WritableMapContext["components"]>;
};