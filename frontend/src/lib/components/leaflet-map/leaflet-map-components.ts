import { type Ref, ref, watch, markRaw, reactive, watchEffect, shallowRef, shallowReadonly, type Raw, nextTick, effectScope, onScopeDispose } from "vue";
import { Control, latLng, latLngBounds, type Map, map as leafletMap, DomUtil, control } from "leaflet";
import "leaflet/dist/leaflet.css";
import { BboxHandler, getIconHtml, getVisibleLayers, HashHandler, LinesLayer, MarkersLayer, SearchResultsLayer, OverpassLayer, OverpassLoadStatus, displayView, getInitialView, coreIconList, defaultVisibleLayers } from "facilmap-leaflet";
import { LocateControl, type LocateOptions } from "leaflet.locatecontrol";
import "leaflet.locatecontrol/dist/L.Control.Locate.css";
import "leaflet-graphicscale";
import "leaflet-graphicscale/dist/Leaflet.GraphicScale.min.css";
import "leaflet-mouse-position";
import "leaflet-mouse-position/src/L.Control.MousePosition.css";
import SelectionHandler from "../../utils/selection";
import { getHashQuery, openSpecialQuery } from "../../utils/zoom";
import mitt from "mitt";
import type { MapComponents, MapContextData, MapContextEvents, WritableMapContext } from "../facil-map-context-provider/map-context";
import type { ClientContext } from "../facil-map-context-provider/client-context";
import type { FacilMapContext } from "../facil-map-context-provider/facil-map-context";
import { requireClientContext } from "../facil-map-context-provider/facil-map-context-provider.vue";
import { type Optional } from "facilmap-utils";
import { getI18n, i18nResourceChangeCounter } from "../../utils/i18n";
import { AttributionControl } from "./attribution";
import { isNarrowBreakpoint } from "../../utils/bootstrap";
import { useWakeLock } from "../../utils/wake-lock";
import storage from "../../utils/storage";
import ChangesetLayer from "facilmap-leaflet";

type MapContextWithoutComponents = Optional<WritableMapContext, 'components'>;

function useMap(element: Ref<HTMLElement>, mapContext: MapContextWithoutComponents): Ref<Raw<Map>> {
	const mapRef = shallowRef(undefined as any as Map);
	const interaction = ref(0);

	watchEffect((onCleanup) => {
		const map = mapRef.value = markRaw(leafletMap(element.value, {
			boxZoom: false,
			attributionControl: false,
			zoomControl: false
		}));

		map._controlCorners.bottomcenter = DomUtil.create("div", "leaflet-bottom fm-leaflet-center", map._controlContainer);

		map.on("moveend", () => {
			mapContext.center = map.getCenter();
			mapContext.zoom = map.getZoom();
			mapContext.bounds = map.getBounds();
		});

		map.on("fmFilter", () => {
			mapContext.filter = map.fmFilter;
			mapContext.filterFunc = map.fmFilterFunc;
		});

		map.on("layeradd layerremove", () => {
			mapContext.layers = getVisibleLayers(map);
		});

		map.on("fmInteractionStart", () => {
			interaction.value++;
		});

		map.on("fmInteractionEnd", () => {
			interaction.value--;
		});

		map.on("locationfound", (data) => {
			mapContext.location = { lat: data.latlng.lat, lon: data.latlng.lng };
		});

		const stopLocate = map.stopLocate;
		map.stopLocate = function() {
			mapContext.location = undefined;
			return stopLocate.call(this);
		};

		onCleanup(() => {
			map.remove();
		});
	});

	watch(() => interaction.value, () => {
		mapContext.interaction = interaction.value > 0;
	}, { immediate: true });

	return mapRef;
}

function useMapComponent<T>(
	map: Ref<Map>,
	construct: () => T,
	activate: (component: T, map: Map) => void
): Ref<T> {
	const componentRef = shallowRef(undefined as any as T);
	watchEffect(() => {
		componentRef.value = construct();
	});

	watch([
		componentRef,
		map
	], ([component, map], prev, onCleanup) => {
		const scope = effectScope();
		scope.run(() => {
			activate(component as any, map);
		});
		onCleanup(() => {
			scope.stop();
		});
	}, { immediate: true });

	return componentRef;
}

function useZoomControl(map: Ref<Map>): Ref<Raw<Control.Zoom>> {
	return useMapComponent(
		map,
		() => markRaw(control.zoom()),
		(zoomControl, map) => {
			watch(() => isNarrowBreakpoint(), (isNarrow) => {
				zoomControl.setPosition(isNarrow ? "bottomright" : "topleft");
			}, { immediate: true });
			map.addControl(zoomControl);

			onScopeDispose(() => {
				zoomControl.remove();
			});
		}
	);
}

function useAttribution(map: Ref<Map>): Ref<Raw<AttributionControl>> {
	return useMapComponent(
		map,
		() => markRaw(new AttributionControl()),
		(attribution, map) => {
			watch(() => isNarrowBreakpoint(), (isNarrow) => {
				if (isNarrow) {
					attribution.remove();
				} else {
					map.addControl(attribution);
				}
			}, { immediate: true });

			watch(i18nResourceChangeCounter, () => {
				attribution.update();
			});

			onScopeDispose(() => {
				attribution.remove();
			});
		}
	);
}

function useBboxHandler(map: Ref<Map>, client: Ref<ClientContext>): Ref<Raw<BboxHandler>> {
	return useMapComponent(
		map,
		() => markRaw(new BboxHandler(map.value, client.value)),
		(bboxHandler) => {
			bboxHandler.enable();
			onScopeDispose(() => {
				bboxHandler.disable();
			});
		}
	);
}

function useGraphicScale(map: Ref<Map>): Ref<Raw<any>> {
	return useMapComponent(
		map,
		() => markRaw(control.graphicScale({ fill: "hollow", position: "bottomcenter" })),
		(graphicScale, map) => {
			watch(() => isNarrowBreakpoint(), (isNarrow) => {
				if (isNarrow) {
					graphicScale.remove();
				} else {
					graphicScale.addTo(map);
				}
			}, { immediate: true });

			onScopeDispose(() => {
				graphicScale.remove();
			});
		}
	);
}

function useLinesLayer(map: Ref<Map>, client: Ref<ClientContext>): Ref<Raw<LinesLayer>> {
	return useMapComponent(
		map,
		() => markRaw(new LinesLayer(client.value)),
		(linesLayer, map) => {
			linesLayer.addTo(map);
			onScopeDispose(() => {
				linesLayer.remove();
			});
		}
	);
}

function useLocateControl(map: Ref<Map>, context: FacilMapContext): Ref<Raw<LocateControl> | undefined> {
	return useMapComponent(
		map,
		() => {
			if (context.settings.locate) {
				if (!coreIconList.includes("screenshot")) {
					console.warn(`Icon "screenshot" is not in core icons.`);
				}

				let screenshotIconHtmlP = getIconHtml("currentColor", "1.5em", "screenshot");

				const locateControl = new LocateControl({
					flyTo: true,
					markerStyle: { pane: "fm-raised-marker", zIndexOffset: 10000 },
					locateOptions: {
						enableHighAccuracy: true
					},
					clickBehavior: {
						inView: "stop",
						outOfView: "setView",
						inViewNotFollowing: "setView"
					},
					setView: "untilPan",
					keepCurrentZoomLevel: false,
					// These class names are not used anywhere, we just set them to avoid the default class names being set,
					// which would apply the default icons using CSS.
					icon: "fm-locate-control-icon",
					iconLoading: "fm-locate-control-icon-loading",
					createButtonCallback: (container, options) => {
						const { link, icon } = (LocateControl.prototype.options as LocateOptions).createButtonCallback!(container, options) as any as { link: HTMLAnchorElement; icon: HTMLElement };
						screenshotIconHtmlP.then((iconHtml) => {
							icon.innerHTML = iconHtml;
						}).catch(console.error);
						return { link, icon };
					}
				});
				return markRaw(Object.assign(Object.create(locateControl), {
					setView(this: typeof locateControl) {
						locateControl.setView.apply(this);

						// After the control zoomed to the location on first activation, we keep the zoom level constant to not annoy
						// the user. This is reset on the "locatedeactivate" event below.
						this.options.keepCurrentZoomLevel = true;
					}
				}));
			}
		},
		(locateControl, map) => {
			if (locateControl) {
				watch(() => isNarrowBreakpoint(), (isNarrow) => {
					locateControl.setPosition(isNarrow ? "bottomright" : "topleft");
				}, { immediate: true });

				locateControl.addTo(map);

				const active = ref(false);
				const handleActivate = () => {
					active.value = true;
				};
				const handleDeactivate = () => {
					active.value = false;
					locateControl.options.keepCurrentZoomLevel = false;
				};
				map.on("locateactivate", handleActivate);
				map.on("locatedeactivate", handleDeactivate);

				const wakeLockScope = effectScope();
				wakeLockScope.run(() => {
					useWakeLock(active);
				});

				onScopeDispose(() => {
					handleDeactivate();
					locateControl.remove();
					map.off("locateactivate", handleActivate);
					map.off("locatedeactivate", handleDeactivate);
					wakeLockScope.stop();
				});
			}
		}
	);
}

function useMarkersLayer(map: Ref<Map>, client: Ref<ClientContext>): Ref<Raw<MarkersLayer>> {
	return useMapComponent(
		map,
		() => markRaw(new MarkersLayer(client.value)),
		(markersLayer, map) => {
			markersLayer.addTo(map);
			onScopeDispose(() => {
				markersLayer.remove();
			});
		}
	);
}

function useMousePosition(map: Ref<Map>): Ref<Raw<Control.MousePosition>> {
	return useMapComponent(
		map,
		() => markRaw(control.mousePosition({ emptyString: "0, 0", separator: ", ", position: "bottomright" })),
		(mousePosition, map) => {
			watch(() => isNarrowBreakpoint(), (isNarrow) => {
				if (isNarrow) {
					mousePosition.remove();
				} else {
					mousePosition.addTo(map);
				}
			}, { immediate: true });

			onScopeDispose(() => {
				mousePosition.remove();
			});
		}
	);
}

function useOverpassLayer(map: Ref<Map>, mapContext: MapContextWithoutComponents): Ref<Raw<OverpassLayer>> {
	return useMapComponent(
		map,
		() => markRaw(new OverpassLayer([], { markerShape: "rectangle-marker" }))
			.on("setQuery", ({ query }: any) => {
				mapContext.overpassIsCustom = typeof query == "string";
				if (mapContext.overpassIsCustom)
					mapContext.overpassCustom = query && typeof query == "string" ? query : "";
				else
					mapContext.overpassPresets = Array.isArray(query) ? query : [];
			})
			.on("loadstart", () => {
				mapContext.loading++;
			})
			.on("loadend", ({ status, error }: any) => {
				mapContext.loading--;

				if (status == OverpassLoadStatus.COMPLETE)
					mapContext.overpassMessage = undefined;
				else if (status == OverpassLoadStatus.INCOMPLETE)
					mapContext.overpassMessage = getI18n().t("leaflet-map-components.pois-too-many-results");
				else if (status == OverpassLoadStatus.TIMEOUT)
					mapContext.overpassMessage = getI18n().t("leaflet-map-components.pois-zoom-in");
				else if (status == OverpassLoadStatus.ERROR)
					mapContext.overpassMessage = getI18n().t("leaflet-map-components.pois-error", { message: error.message });
			})
			.on("clear", () => {
				mapContext.overpassMessage = undefined;
			}),
		(overpassLayer, map) => {
			overpassLayer.addTo(map)
			onScopeDispose(() => {
				overpassLayer.remove();
			});
		}
	);
}

function useSearchResultsLayer(map: Ref<Map>): Ref<Raw<SearchResultsLayer>> {
	return useMapComponent(
		map,
		() => markRaw(new SearchResultsLayer(undefined, { pathOptions: { weight: 7 } })),
		(searchResultsLayer, map) => {
			searchResultsLayer.addTo(map);
			onScopeDispose(() => {
				searchResultsLayer.remove();
			});
		}
	);
}

function useChangesetLayer(map: Ref<Map>): Ref<Raw<ChangesetLayer>> {
	return useMapComponent(
		map,
		() => markRaw(new ChangesetLayer(undefined, { pathOptions: { weight: 7 } })),
		(changesetLayer, map) => {
			changesetLayer.addTo(map);
			onScopeDispose(() => {
				changesetLayer.remove();
			});
		}
	);
}

function useSelectionHandler(map: Ref<Map>, context: FacilMapContext, mapContext: MapContextWithoutComponents, markersLayer: Ref<MarkersLayer>, linesLayer: Ref<LinesLayer>, searchResultsLayer: Ref<SearchResultsLayer>, changesetLayer: Ref<ChangesetLayer>, overpassLayer: Ref<OverpassLayer>): Ref<Raw<SelectionHandler>> {
	return useMapComponent(
		map,
		() => {
			const selectionHandler = markRaw(new SelectionHandler(map.value, markersLayer.value, linesLayer.value, searchResultsLayer.value, changesetLayer.value, overpassLayer.value));

			selectionHandler.on("fmChangeSelection", (event: any) => {
				const selection = selectionHandler.getSelection();
				mapContext.selection = selection;

				if (event.open) {
					setTimeout(() => {
						mapContext.emit("open-selection", { selection });
					}, 0);
				}
			});

			selectionHandler.on("fmLongClick", (event: any) => {
				void context.components.clickMarkerTab?.openClickMarker({ lat: event.latlng.lat, lon: event.latlng.lng });
			});

			selectionHandler.on("fmLongClickAbort", () => {
				context.components.clickMarkerTab?.closeLastClickMarker();
			});

			return selectionHandler;
		},
		(selectionHandler) => {
			selectionHandler.enable();
			onScopeDispose(() => {
				selectionHandler.disable();
			});
		}
	);
}

function useHashHandler(map: Ref<Map>, client: Ref<ClientContext>, context: FacilMapContext, mapContext: MapContextWithoutComponents, overpassLayer: Ref<OverpassLayer>): Ref<Raw<HashHandler & { _fmActivate: () => Promise<void> }>> {
	return useMapComponent(
		map,
		() => {
			let queryChangePromise: Promise<void> | undefined;
			const hashHandler = markRaw(new HashHandler(map.value, client.value, { overpassLayer: overpassLayer.value, simulate: !context.settings.updateHash }))
				.on("fmQueryChange", async (e: any) => {
					let smooth = true;
					let autofocus = false;

					const searchFormTab = context.components.searchFormTab;
					queryChangePromise = (async () => {
						if (!e.query)
							await searchFormTab?.setQuery("", false, false).zoomed;
						else if (!await openSpecialQuery(e.query, context, e.zoom, smooth))
							await searchFormTab?.setQuery(e.query, e.zoom, smooth, autofocus).zoomed;
					})();
					await queryChangePromise;
				})
				.on("fmHash", (e: any) => {
					mapContext.hash = e.hash;
				});
			return Object.assign(hashHandler, {
				_fmActivate: async () => {
					hashHandler.enable();
					await queryChangePromise;
				}
			});
		},
		(hashHandler) => {
			onScopeDispose(() => {
				hashHandler.disable();
			});
		}
	);
}

function useMapComponents(context: FacilMapContext, mapContext: MapContextWithoutComponents, mapRef: Ref<HTMLElement>, innerContainerRef: Ref<HTMLElement>): MapComponents {
	const client = requireClientContext(context);
	const map = useMap(mapRef, mapContext);
	const attribution = useAttribution(map);
	const zoomControl = useZoomControl(map);
	const bboxHandler = useBboxHandler(map, client);
	const graphicScale = useGraphicScale(map);
	const linesLayer = useLinesLayer(map, client);
	const locateControl = useLocateControl(map, context);
	const markersLayer = useMarkersLayer(map, client);
	const mousePosition = useMousePosition(map);
	const overpassLayer = useOverpassLayer(map, mapContext);
	const searchResultsLayer = useSearchResultsLayer(map);
	const changesetLayer = useChangesetLayer(map);
	const selectionHandler = useSelectionHandler(map, context, mapContext, markersLayer, linesLayer, searchResultsLayer, changesetLayer, overpassLayer);
	const hashHandler = useHashHandler(map, client, context, mapContext, overpassLayer);

	const components: MapComponents = reactive({
		map,
		zoomControl,
		attribution,
		bboxHandler,
		graphicScale,
		linesLayer,
		locateControl,
		markersLayer,
		mousePosition,
		overpassLayer,
		searchResultsLayer,
		changesetLayer,
		selectionHandler,
		hashHandler,
		container: innerContainerRef
	});

	return shallowReadonly(components);
}

export async function useMapContext(context: FacilMapContext, mapRef: Ref<HTMLElement>, innerContainerRef: Ref<HTMLElement>): Promise<WritableMapContext> {
	const mapContextWithoutComponents: MapContextWithoutComponents = reactive(Object.assign(mitt<MapContextEvents>(), {
		center: latLng(0, 0),
		zoom: 1,
		bounds: latLngBounds([0, 0], [0, 0]),
		layers: { baseLayer: "", overlays: [] },
		filter: undefined,
		filterFunc: () => true,
		hash: location.hash.replace(/^#/, ""),
		showToolbox: false,
		selection: [],
		activeQuery: undefined,
		fallbackQuery: undefined,
		setFallbackQuery: (query) => {
			mapContext.fallbackQuery = query;
		},
		interaction: false,
		loading: 0,
		overpassIsCustom: false,
		overpassPresets: [],
		overpassCustom: "",
		overpassMessage: undefined,
		location: undefined,
		loaded: false,
		fatalError: undefined,
		runOperation: async (operation) => {
			try {
				mapContextWithoutComponents.loading++;
				return await operation();
			} finally {
				mapContextWithoutComponents.loading--;
			}
		}
	} satisfies Omit<MapContextData, 'components'>));

	const mapContext: WritableMapContext = Object.assign(mapContextWithoutComponents, {
		components: useMapComponents(context, mapContextWithoutComponents, mapRef, innerContainerRef)
	});

	const map = mapContext.components.map;
	const overpassLayer = mapContext.components.overpassLayer;

	const client = requireClientContext(context);

	(async () => {
		await nextTick(); // useMapContext() return promise is resolved, setting mapContext.value in <LeafletMap>
		await nextTick(); // <LeafletMap> rerenders with its slot, search box tabs are now available and can receive the query from the hash handler

		await mapContext.components.hashHandler._fmActivate();

		if (!map._loaded) {
			try {
				// Initial view was not set by hash handler
				const initialView = await getInitialView(client.value);
				displayView(map, {
					top: -90, bottom: 90, left: -180, right: 180,
					...initialView,
					baseLayer: initialView?.baseLayer ?? storage.baseLayer ?? defaultVisibleLayers.baseLayer,
					layers: initialView?.layers ?? storage.overlays ?? defaultVisibleLayers.overlays
				}, { overpassLayer });
			} catch (error) {
				console.error(error);
				displayView(map, undefined, { overpassLayer });
			}
		}

		watch(() => mapContext.components.hashHandler, async (hashHandler) => {
			await hashHandler._fmActivate();
		});

		watchEffect(() => {
			mapContext.activeQuery = getHashQuery(mapContext.components.map, client.value, mapContext.selection) || mapContext.fallbackQuery;
			mapContext.components.hashHandler.setQuery(mapContext.activeQuery);
		});
	})().catch(console.error);

	return mapContext;
}

/* function createButton(icon: Icon, onClick: () => void): Control {
	return Object.assign(new Control(), {
		onAdd() {
			const div = document.createElement('div');
			div.className = "leaflet-bar";
			const a = document.createElement('a');
			a.href = "javascript:";
			a.innerHTML = createIconHtml("currentColor", "1.5em", icon);
			a.addEventListener("click", (e) => {
				e.preventDefault();
				onClick();
			});
			div.appendChild(a);
			return div;
		}
	});
} */