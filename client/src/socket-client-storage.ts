import type {
	ID, Marker, LineWithTrackPoints, View, Type, HistoryEntry, EventName, EventHandler, MapDataWithWritable,
	MapSlug, TrackPoints, Route, Line, LinePoints, RoutePoints, DeepReadonly
} from "facilmap-types";
import { SocketClient, type ClientEvents } from "./socket-client";
import { DefaultReactiveObjectProvider, type ReactiveObjectProvider } from "./reactivity";
import { mergeTrackPoints } from "./utils";

export interface MapStorage {
	mapData: DeepReadonly<MapDataWithWritable> | undefined;
	markers: Record<ID, DeepReadonly<Marker>>;
	lines: Record<ID, DeepReadonly<LineWithTrackPoints>>;
	views: Record<ID, DeepReadonly<View>>;
	types: Record<ID, DeepReadonly<Type>>;
	history: Record<ID, DeepReadonly<HistoryEntry>>;
};

export type RouteWithTrackPoints = Route & { trackPoints: TrackPoints };

export class SocketClientStorage {
	reactiveObjectProvider: ReactiveObjectProvider;
	client: SocketClient;

	maps: Record<MapSlug, MapStorage>;
	routes: Record<string, DeepReadonly<RouteWithTrackPoints>>;

	constructor(client: SocketClient, options?: { reactiveObjectProvider?: ReactiveObjectProvider }) {
		this.reactiveObjectProvider = options?.reactiveObjectProvider ?? new DefaultReactiveObjectProvider();
		this.client = client;
		this.maps = this.reactiveObjectProvider.makeReactive({});
		this.routes = this.reactiveObjectProvider.makeReactive({});

		for(const [i, handler] of Object.entries(this._getEventHandlers())) {
			this.client.on(i as any, handler as any);
		}
	}

	dispose(): void {
		for(const [i, handler] of Object.entries(this._getEventHandlers())) {
			this.client.removeListener(i as any, handler as any);
		}
		this.maps = this.reactiveObjectProvider.makeReactive({});
		this.routes = this.reactiveObjectProvider.makeReactive({});
	}

	protected _getEventHandlers(): {
		[E in EventName<ClientEvents>]?: EventHandler<ClientEvents, E>
	} {
		return {
			mapData: (mapSlug, data) => {
				if (this.maps[mapSlug]) {
					this.storeMapData(mapSlug, data);
				}
			},

			marker: (mapSlug, data) => {
				if (this.maps[mapSlug]) {
					this.storeMarker(mapSlug, data);
				}
			},

			deleteMarker: (mapSlug, data) => {
				if (this.maps[mapSlug]) {
					this.clearMarker(mapSlug, data.id);
				}
			},

			line: (mapSlug, data) => {
				if (this.maps[mapSlug]) {
					this.storeLine(mapSlug, data);
				}
			},

			deleteLine: (mapSlug, data) => {
				if (this.maps[mapSlug]) {
					this.clearLine(mapSlug, data.id);
				}
			},

			linePoints: (mapSlug, data) => {
				if (this.maps[mapSlug]) {
					this.storeLinePoints(mapSlug, data, true);
				}
			},

			view: (mapSlug, data) => {
				if (this.maps[mapSlug]) {
					this.storeView(mapSlug, data);
				}
			},

			deleteView: (mapSlug, data) => {
				if (this.maps[mapSlug]) {
					this.clearView(mapSlug, data.id);

					if(this.maps[mapSlug].mapData?.defaultViewId === data.id) {
						this.storeMapData(mapSlug, {
							...this.maps[mapSlug].mapData!,
							defaultView: null,
							defaultViewId: null
						});
					}
				}
			},

			type: (mapSlug, data) => {
				if (this.maps[mapSlug]) {
					this.storeType(mapSlug, data);
				}
			},

			deleteType: (mapSlug, data) => {
				if (this.maps[mapSlug]) {
					this.clearType(mapSlug, data.id);
				}
			},

			history: (mapSlug, data) => {
				if (this.maps[mapSlug]) {
					this.storeHistoryEntry(mapSlug, data);
				}
			},

			route: (routeKey, data) => {
				this.storeRoute(routeKey, data);
			},

			routePoints: (routeKey, { reset, ...routePoints }) => {
				this.storeRoutePoints(routeKey, routePoints, reset);
			},

			emit: (...args) => {
				switch (args[0]) {
					case "subscribeToMap":
						this.reactiveObjectProvider.set(this.maps, args[1].args[0], {
							mapData: undefined,
							markers: {},
							lines: {},
							types: {},
							views: {},
							history: {}
						});
						break;

					case "unsubscribeFromMap":
						this.reactiveObjectProvider.delete(this.maps, args[1].args[0]);
						break;

					case "unsubscribeFromRoute":
						this.reactiveObjectProvider.delete(this.routes, args[1].args[0]);
						break;

					case "setBbox":
						if (this.client.bbox && args[1].args[0].zoom !== this.client.bbox.zoom) {
							// Reset line points on zoom change to prevent us from accumulating too many unneeded line points.
							// On zoom change the line points are sent from the server without applying the "except" rule for the last bbox,
							// so we can be sure that we will receive all line points that are relevant for the new bbox.

							const linesHandled = new Set<ID>();
							const linePointsHandler: EventHandler<ClientEvents, "linePoints"> = (mapSlug, data) => {
								linesHandled.add(data.lineId);
							};
							this.client.on("linePoints", linePointsHandler);

							args[1].result.finally(() => {
								this.client.removeListener("linePoints", linePointsHandler);
							}).catch((err) => console.error(err));

							args[1].result.then(() => {
								for (const [mapSlug, objs] of Object.entries(this.maps)) {
									for (const lineId_ of Object.keys(objs.lines)) {
										const lineId = Number(lineId_);
										if (!linesHandled.has(lineId)) {
											this.storeLinePoints(mapSlug, { lineId, trackPoints: [] }, true);
										}
									}
								}
							}).catch((err) => console.error(err));
						}
				}
			}
		};
	};


	protected getMapStorage(mapSlug: MapSlug): MapStorage {
		if (!this.maps[mapSlug]) {
			throw new Error(`Map ${mapSlug} is not in storage.`);
		}
		return this.maps[mapSlug];
	}

	storeMapData(mapSlug: MapSlug, mapData: MapDataWithWritable): void {
		this.reactiveObjectProvider.set(this.getMapStorage(mapSlug), "mapData", mapData);
	}

	storeMarker(mapSlug: MapSlug, marker: Marker): void {
		this.reactiveObjectProvider.set(this.getMapStorage(mapSlug).markers, marker.id, marker);
	}

	clearMarker(mapSlug: MapSlug, markerId: ID): void {
		this.reactiveObjectProvider.delete(this.getMapStorage(mapSlug).markers, markerId);
	}

	storeLine(mapSlug: MapSlug, line: Line): void {
		this.reactiveObjectProvider.set(this.getMapStorage(mapSlug).lines, line.id, {
			...line,
			trackPoints: this.maps[mapSlug].lines[line.id]?.trackPoints || { length: 0 }
		});
	}

	storeLinePoints(mapSlug: MapSlug, linePoints: LinePoints, reset: boolean): void {
		const line = this.getMapStorage(mapSlug).lines[linePoints.lineId];
		if (!line) {
			console.error(`Received line points for non-existing line ${linePoints.lineId}.`);
			return;
		}

		this.reactiveObjectProvider.set(this.getMapStorage(mapSlug).lines, linePoints.lineId, {
			...line,
			trackPoints: mergeTrackPoints(reset ? {} : line.trackPoints, linePoints.trackPoints)
		});
	}

	clearLine(mapSlug: MapSlug, lineId: ID): void {
		this.reactiveObjectProvider.delete(this.getMapStorage(mapSlug).lines, lineId);
	}

	storeType(mapSlug: MapSlug, type: Type): void {
		this.reactiveObjectProvider.set(this.getMapStorage(mapSlug).types, type.id, type);
	}

	clearType(mapSlug: MapSlug, typeId: ID): void {
		this.reactiveObjectProvider.delete(this.getMapStorage(mapSlug).types, typeId);
	}

	storeView(mapSlug: MapSlug, view: View): void {
		this.reactiveObjectProvider.set(this.getMapStorage(mapSlug).views, view.id, view);
	}

	clearView(mapSlug: MapSlug, viewId: ID): void {
		this.reactiveObjectProvider.delete(this.getMapStorage(mapSlug).views, viewId);
	}

	storeHistoryEntry(mapSlug: MapSlug, historyEntry: HistoryEntry): void {
		this.reactiveObjectProvider.set(this.getMapStorage(mapSlug).history, historyEntry.id, historyEntry);
		// TODO: Limit to 50 entries
	}

	clearHistoryEntry(mapSlug: MapSlug, historyEntryId: ID): void {
		this.reactiveObjectProvider.delete(this.getMapStorage(mapSlug).history, historyEntryId);
	}

	storeRoute(routeKey: string, route: Route): void {
		this.reactiveObjectProvider.set(this.routes, routeKey, {
			...route,
			trackPoints: this.routes[routeKey]?.trackPoints || { length: 0 }
		});
	}

	storeRoutePoints(routeKey: string, routePoints: RoutePoints, reset: boolean): void {
		const route = this.routes[routeKey];
		if (!route) {
			throw new Error(`Route ${routeKey} is not in storage.`);
		}

		this.reactiveObjectProvider.set(this.routes, routeKey, {
			...route,
			trackPoints: mergeTrackPoints(reset ? {} : route.trackPoints, routePoints.trackPoints)
		});
	}

}