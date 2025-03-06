import type { ID, SearchResult } from "facilmap-types";
import { DomEvent, Evented, Handler, type LatLngBounds, type LeafletEvent, type Map, type Point, Polyline, Util } from "leaflet";
import { LinesLayer, MarkerLayer, MarkersLayer, type OverpassElement, OverpassLayer, SearchResultsLayer } from "facilmap-leaflet";
import BoxSelection from "./box-selection";
import type { DeepReadonly } from "vue";
import type ChangesetLayer from "facilmap-leaflet";
import type { ChangesetFeature } from "facilmap-utils";

export type SelectedItem = {
	type: "marker" | "line";
	id: ID;
} | {
	type: "searchResult";
	result: SearchResult;
	layerId: number;
} | {
	type: "changeset";
	feature: ChangesetFeature;
} | {
	type: "overpass";
	element: OverpassElement;
};

function isAllowedSibling(a: DeepReadonly<SelectedItem>, b: DeepReadonly<SelectedItem>) {
	if (["marker", "line"].includes(a.type) && ["marker", "line"].includes(b.type))
		return true;
	else if (a.type == "searchResult" && b.type == "searchResult")
		return a.layerId == b.layerId;
	else if (a.type == "overpass" && b.type == "overpass")
		return true;
	else
		return false;
}

function byType<T extends SelectedItem["type"]>(items: Array<DeepReadonly<SelectedItem>>, type: T): Array<SelectedItem & { type: T }> {
	return items.filter((i) => i.type === type) as any;
}

function isSame(a: DeepReadonly<SelectedItem>, b: DeepReadonly<SelectedItem>): boolean {
	if ((a.type == "marker" && b.type == "marker") || (a.type == "line" && b.type == "line"))
		return a.id == b.id;
	else if (a.type == "searchResult" && b.type == "searchResult")
		return a.result === b.result;
	else if (a.type == "overpass" && b.type == "overpass")
		return a.element === b.element;
	else if (a.type === "changeset" && b.type === "changeset")
		return a.feature === b.feature;
	else
		return false;
}

export default class SelectionHandler extends Handler {

	_selection: Array<DeepReadonly<SelectedItem>> = [];

	_markersLayer: MarkersLayer;
	_linesLayer: LinesLayer;
	_searchResultLayers: SearchResultsLayer[];
	_changesetLayer: ChangesetLayer;
	_overpassLayer: OverpassLayer;

	_boxSelectionHandler: BoxSelection;
	_selectionBeforeBox: Array<DeepReadonly<SelectedItem>> = [];
	_isBoxInteraction = false;

	_mapInteraction: number = 0;
	_isLongClick: boolean = false;

	constructor(map: Map, markersLayer: MarkersLayer, linesLayer: LinesLayer, searchResultsLayer: SearchResultsLayer, changesetLayer: ChangesetLayer, overpassLayer: OverpassLayer) {
		super(map);

		this._boxSelectionHandler = new BoxSelection(map)
			.on("selectstart", this.handleBoxSelectStart)
			.on("select", this.handleBoxSelect)
			.on("selectend", this.handleBoxSelectEnd);

		this._markersLayer = markersLayer;
		this._linesLayer = linesLayer;
		this._searchResultLayers = [searchResultsLayer];
		this._changesetLayer = changesetLayer;
		this._overpassLayer = overpassLayer;
	}

	enable(): this {
		super.enable();
		this._boxSelectionHandler.enable();
		return this;
	}

	disable(): this {
		this._boxSelectionHandler.disable();
		super.disable();
		return this;
	}

	addHooks(): void {
		this._markersLayer.on("click", this.handleClickMarker);
		this._linesLayer.on("click", this.handleClickLine);
		for (const layer of this._searchResultLayers)
			layer.on("click", this.handleClickSearchResult);
		this._changesetLayer.on("click", this.handleClickChangeset);
		this._overpassLayer.on("click", this.handleClickOverpass);
		this._map.on("click", this.handleClickMap);
		this._map.on("fmInteractionStart", this.handleMapInteractionStart);
		this._map.on("fmInteractionEnd", this.handleMapInteractionEnd);

		this._map.getContainer().addEventListener("click", this.handleMapClickCapture, { capture: true });
		this._map.getContainer().addEventListener("mousedown", this.handleMapMouseDown);
		this._map.getContainer().addEventListener("touchstart", this.handleMapMouseDown);
	}

	removeHooks(): void {
		this._markersLayer.off("click", this.handleClickMarker);
		this._linesLayer.off("click", this.handleClickLine);
		for (const layer of this._searchResultLayers)
			layer.off("click", this.handleClickSearchResult);
		this._changesetLayer.off("click", this.handleClickChangeset);
		this._overpassLayer.off("click", this.handleClickOverpass);
		this._map.off("click", this.handleClickMap);
		this._map.off("fmInteractionStart", this.handleMapInteractionStart);
		this._map.off("fmInteractionEnd", this.handleMapInteractionEnd);
		this._map.getContainer().removeEventListener("click", this.handleMapClickCapture, { capture: true });
		this._map.getContainer().removeEventListener("mousedown", this.handleMapMouseDown);
		this._map.getContainer().removeEventListener("touchstart", this.handleMapMouseDown);
	}

	addSearchResultLayer(layer: SearchResultsLayer): void {
		if (this._searchResultLayers.includes(layer))
			return;

		if (this._enabled)
			layer.on("click", this.handleClickSearchResult);

		this._searchResultLayers.push(layer);
	}

	removeSearchResultLayer(layer: SearchResultsLayer): void {
		const idx = this._searchResultLayers.indexOf(layer);
		if (idx == -1)
			return;

		layer.off("click", this.handleClickSearchResult);
		this._searchResultLayers.splice(idx, 1);

		const layerId = Util.stamp(layer);
		const without = this._selection.filter((item) => item.type != "searchResult" || item.layerId != layerId);
		if (without.length != this._selection.length)
			this.setSelectedItems(without);
	}

	getSelection(): Array<DeepReadonly<SelectedItem>> {
		return this._selection;
	}

	setSelectedItems(items: Array<DeepReadonly<SelectedItem>>, open = false): void {
		this._selection = items;

		this._markersLayer.setHighlightedMarkers(new Set(
			byType(items, "marker").map((i) => i.id)
		));
		this._linesLayer.setHighlightedLines(new Set(
			byType(items, "line").map((i) => i.id)
		));
		for (const layer of this._searchResultLayers) {
			const layerId = Util.stamp(layer);
			layer.setHighlightedResults(new Set(
				byType(items, "searchResult").filter((i) => i.layerId == layerId).map((i) => i.result)
			));
		}
		this._changesetLayer.setHighlightedFeatures(new Set(byType(items, "changeset").map((i) => i.feature)));
		this._overpassLayer.setHighlightedElements(new Set(
			byType(items, "overpass").map((i) => i.element)
		));

		this.fire("fmChangeSelection", { open });
	}

	isSelected(item: SelectedItem): boolean {
		return this._selection.some((i) => isSame(i, item));
	}

	selectItem(item: SelectedItem, open = false): void {
		if (!this.isSelected(item))
			this.setSelectedItems([...this._selection, item], open);
		else if (open)
			this.fire("fmChangeSelection", { open });
	}

	unselectItem(item: SelectedItem): void {
		this.setSelectedItems(this._selection.filter((i) => !isSame(i, item)));
	}

	toggleItem(item: SelectedItem, open = false): void {
		if (this.isSelected(item))
			this.unselectItem(item);
		else if (!this._selection.some((i) => !isAllowedSibling(item, i)))
			this.selectItem(item, open);
	}

	handleClickItem(item: SelectedItem, e: LeafletEvent): void {
		if (this._mapInteraction)
			return;

		DomEvent.stopPropagation(e);
		if ((e.originalEvent as any).ctrlKey)
			this.toggleItem(item, true);
		else
			this.setSelectedItems([item], true);
	}

	handleClickMarker = (e: LeafletEvent): void => {
		if (e.propagatedFrom?.marker?.id)
			this.handleClickItem({ type: "marker", id: e.propagatedFrom.marker.id }, e);
	}

	handleClickLine = (e: LeafletEvent): void => {
		if (e.propagatedFrom?.line?.id)
			this.handleClickItem({ type: "line", id: e.propagatedFrom.line.id }, e);
	}

	handleClickSearchResult = (e: LeafletEvent): void => {
		if (e.propagatedFrom?._fmSearchResult)
			this.handleClickItem({ type: "searchResult", result: e.propagatedFrom._fmSearchResult, layerId: Util.stamp(e.target) }, e);
	}

	handleClickChangeset = (e: LeafletEvent): void => {
		if (e.propagatedFrom?._fmChangesetFeature) {
			this.handleClickItem({ type: "changeset", feature: e.propagatedFrom._fmChangesetFeature }, e);
		}
	};

	handleClickOverpass = (e: LeafletEvent): void => {
		if (e.propagatedFrom?._fmOverpassElement)
			this.handleClickItem({ type: "overpass", element: e.propagatedFrom._fmOverpassElement }, e);
	}

	handleClickMap = (e: LeafletEvent): void => {
		if (this._mapInteraction || this._isLongClick || this._isBoxInteraction)
			return;

		if (!(e.originalEvent as any).ctrlKey)
			this.setSelectedItems([]);
	}

	handleMapClickCapture = (e: MouseEvent): void => {
		if (this._isLongClick) {
			// Prevent click on map object under mouse cursor
			e.stopPropagation();
		}
	}

	handleMapMouseDown = (e: MouseEvent | TouchEvent): void => {
		if ("button" in e && e.button != null && e.button != 0) // Only react to left click
			return;
		if ("touches" in e && e.touches && e.touches.length != 1)
			return;
		if (this._mapInteraction) {
			return;
		}

		const pos: Point = this._map.mouseEventToContainerPoint(("touches" in e ? e.touches[0] : e) as any);
		let fired = false;
		let timeout = setTimeout(() => {
			this._isLongClick = true;
			this.fire("fmLongClick", { latlng: this._map.mouseEventToLatLng(("touches" in e ? e.touches[0] : e) as any) });
			fired = true;
		}, 500);

		const handleMouseMove = (e: any) => {
			if(pos.distanceTo(this._map.mouseEventToContainerPoint(("touches" in e ? e.touches[0] : e) as any)) > (this._map.dragging as any)._draggable.options.clickTolerance) {
				clear();

				if (fired) {
					this.fire("fmLongClickAbort");
				}
			}
		};

		const handleContextMenu = (e: any) => {
			DomEvent.preventDefault(e);
		}

		const clear = () => {
			clearTimeout(timeout);
			this._map.getContainer().removeEventListener("mousemove", handleMouseMove);
			this._map.getContainer().removeEventListener("touchmove", handleMouseMove);
			this._map.getContainer().removeEventListener("mouseup", clear);
			this._map.getContainer().removeEventListener("touchend", clear);
			this._map.getContainer().removeEventListener("contextmenu", handleContextMenu);

			setTimeout(() => {
				this._isLongClick = false;
			}, 0);
		}

		this._map.getContainer().addEventListener("mousemove", handleMouseMove);
		this._map.getContainer().addEventListener("touchmove", handleMouseMove);
		this._map.getContainer().addEventListener("mouseup", clear);
		this._map.getContainer().addEventListener("touchend", clear);
		this._map.getContainer().addEventListener("contextmenu", handleContextMenu);
	}

	handleMapInteractionStart = (): void => {
		this._mapInteraction++;
	}

	handleMapInteractionEnd = (): void => {
		this._mapInteraction--;
	}

	handleBoxSelectStart = (e: any): void => {
		this._isBoxInteraction = true;
		this._selectionBeforeBox = e.ctrlKey ? [...this._selection] : [];
	}

	handleBoxSelect = (e: any): void => {
		const bounds: LatLngBounds = e.bounds;

		const selection = [
			...this._markersLayer.getLayers()
				.filter((layer) => layer instanceof MarkerLayer && bounds.contains(layer.getLatLng()))
				.map((layer): SelectedItem => ({ type: "marker", id: (layer as any).marker.id })),
			...this._linesLayer.getLayers()
				.filter((layer) => layer instanceof Polyline && bounds.contains(layer.getBounds()))
				.map((layer): SelectedItem => ({ type: "line", id: (layer as any).line.id }))
		].filter((item1) => !this._selectionBeforeBox.some((item2) => isSame(item1, item2)));

		if (selection.length == 0)
			this.setSelectedItems(this._selectionBeforeBox, true);
		else {
			this.setSelectedItems([
				...this._selectionBeforeBox.filter((item) => isAllowedSibling(selection[0], item)),
				...selection
			], true);
		}
	}

	handleBoxSelectEnd = (): void => {
		this._selectionBeforeBox = [];

		setTimeout(() => {
			this._isBoxInteraction = false;
		}, 0);
	}

}

export default interface SelectionHandler extends Evented {}
Object.assign(SelectionHandler.prototype, Evented.prototype);
