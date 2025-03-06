<script setup lang="ts">
	import { useI18n } from "../../../utils/i18n";
	import { renderOsmTag, type AnalyzedChangeset, type ChangesetFeature } from "facilmap-utils";
	import { computed, ref, toRaw, watch } from "vue";
	import { useCarousel } from "../../../utils/carousel";
	import { injectContextRequired, requireMapContext } from "../facil-map-context-provider/facil-map-context-provider.vue";
	import Icon from "../ui/icon.vue";
	import vTooltip from "../../../utils/tooltip";
	import { vScrollIntoView } from "../../../utils/vue";
	import { combineZoomDestinations, flyTo, getZoomDestinationForChangeset, getZoomDestinationForChangesetFeature } from "../../../utils/zoom";
	import ZoomToObjectButton from "../ui/zoom-to-object-button.vue";
	import ChangesetFeatureInfo from "./changeset-feature-info.vue";
	import { getChangesetFeatureLabel } from "./utils";
	import { isEqual } from "lodash-es";

	const context = injectContextRequired();
	const mapContext = requireMapContext(context);
	const i18n = useI18n();

	const props = withDefaults(defineProps<{
		changeset: AnalyzedChangeset;
		/** When clicking a search result, union zoom to it. Normal zoom is done when clicking the zoom button. */
		unionZoom?: boolean;
		/** When clicking or selecting a search result, zoom to it. */
		autoZoom?: boolean;
	}>(), {
		unionZoom: false,
		autoZoom: false
	});

	const carouselRef = ref<HTMLElement>();
	const carousel = useCarousel(carouselRef);

	const zoomDestination = computed(() => getZoomDestinationForChangeset(props.changeset));

	const activeFeatures = computed(() => props.changeset.features.filter((f) => mapContext.value.selection.some((i) => i.type === "changeset" && i.feature === f)));
	const openFeature = computed(() => activeFeatures.value.length == 1 ? activeFeatures.value[0] : undefined);

	watch(openFeature, () => {
		if (!openFeature.value && carousel.tab !== 0) {
			carousel.setTab(0);
		}
	});

	const featureData = computed(() => props.changeset.features.map((feature) => ({
		key: `${feature.type}-${feature.id}`,
		feature,
		icon: (
			!feature.new ? "square-minus" :
			!feature.old ? "square-plus" :
			"square"
		),
		iconTooltip: (
			!feature.new ? i18n.t("changeset-results.deleted-tooltip") :
			!feature.old ? i18n.t("changeset-results.created-tooltip") :
			i18n.t("changeset-results.modified-tooltip")
		),
		className: (
			!feature.new ? "deleted" :
			!feature.old ? "created" :
			"modified"
		),
		label: getChangesetFeatureLabel(feature),
		zoomDestination: getZoomDestinationForChangesetFeature(feature),
		hasTagChanges:
			(feature.old && feature.new && !isEqual(toRaw(feature.old.tags ?? {}), toRaw(feature.new.tags ?? {})))
			|| (!feature.old && Object.keys(feature.new.tags ?? {}).length > 0)
			|| (feature.type === "relation" && feature.old && feature.new && !isEqual(toRaw(feature.old.members), toRaw(feature.new.members)))
	})));

	const showZoom = computed(() => !props.autoZoom || props.unionZoom);

	function zoomToSelectedResults(unionZoom: boolean): void {
		let dest = combineZoomDestinations(activeFeatures.value.map((f) => getZoomDestinationForChangesetFeature(f)));
		if (dest && unionZoom)
			dest = combineZoomDestinations([dest, { bounds: mapContext.value.components.map.getBounds() }]);
		if (dest)
			flyTo(mapContext.value.components.map, dest);
	}

	function handleClick(feature: ChangesetFeature): void {
		selectFeature(feature);

		if (props.autoZoom)
			zoomToSelectedResults(props.unionZoom);
	}

	function selectFeature(feature: ChangesetFeature): void {
		mapContext.value.components.selectionHandler.setSelectedItems([{ type: "changeset", feature }]);
	}

	function handleOpen(feature: ChangesetFeature): void {
		selectFeature(feature);

		setTimeout(async () => {
			carousel.setTab(1);
		}, 0);
	}

	function closeFeature(): void {
		carousel.setTab(0);
	}
</script>

<template>
	<div class="fm-changeset-results">
		<div class="carousel slide fm-flex-carousel" ref="carouselRef">
			<div class="carousel-item" :class="{ active: carousel.tab === 0 }">
				<div class="fm-search-box-collapse-point">
					<h2>{{i18n.t("changeset-results.heading", { id: props.changeset.changeset.id })}}</h2>
					<dl class="fm-search-box-dl">
						<dt>{{i18n.t("changeset-results.created")}}</dt>
						<dd>{{props.changeset.changeset.created_at.toISOString().replace(".000", "")}}</dd>

						<dt>{{i18n.t("changeset-results.closed")}}</dt>
						<dd>{{props.changeset.changeset.closed_at.toISOString().replace(".000", "")}}</dd>

						<dt>{{i18n.t("changeset-results.user")}}</dt>
						<dd>
							<a
								:href="`https://www.openstreetmap.org/user/${encodeURIComponent(props.changeset.changeset.user)}`"
								target="_blank"
							>{{props.changeset.changeset.user}} <Icon icon="new-window" size="1em"></Icon></a>
						</dd>

						<template v-for="(value, key) in props.changeset.changeset.tags" :key="key">
							<dt>{{key}}</dt>
							<dd class="text-break" v-html="renderOsmTag(key as string, value)"></dd>
						</template>
					</dl>

					<h3>{{i18n.t("changeset-results.features")}}</h3>
					<ul class="list-group">
						<li
							v-for="data in featureData"
							:key="data.key"
							class="list-group-item"
							:class="[{ active: activeFeatures.includes(data.feature) }, data.className]"
							v-scroll-into-view="activeFeatures.includes(data.feature)"
						>
							<span>
								<Icon :icon="data.icon" v-tooltip="data.iconTooltip" />
								<a href="javascript:" class="ms-1" @click="handleClick(data.feature)">
									{{data.label}}
								</a>
							</span>

							<a
								v-if="showZoom && data.zoomDestination"
								href="javascript:"
								@click="flyTo(mapContext.components.map, data.zoomDestination)"
								v-tooltip.hover.left="i18n.t('changeset-results.zoom-to-feature-tooltip')"
							><Icon icon="zoom-in" :alt="i18n.t('changeset-results.zoom-to-feature-alt')"></Icon></a>

							<a
								href="javascript:"
								@click="handleOpen(data.feature)"
								v-tooltip.left="data.hasTagChanges ? i18n.t('changeset-results.show-details-tooltip') : data.feature.type === 'relation' ? i18n.t('changeset-results.show-details-no-tag-member-changes-tooltip') : i18n.t('changeset-results.show-details-no-tag-changes-tooltip')"
								:class="data.hasTagChanges ? '' : 'opacity-25'"
							><Icon icon="arrow-right" :alt="i18n.t('changeset-results.show-details-alt')"></Icon></a>
						</li>
					</ul>
				</div>
				<div class="btn-toolbar mt-2">
					<ZoomToObjectButton
						:label="i18n.t('changeset-results.zoom-to-changeset-label')"
						size="sm"
						:destination="zoomDestination"
					></ZoomToObjectButton>

					<a
						class="btn btn-secondary btn-sm"
						:href="`https://www.openstreetmap.org/changeset/${encodeURIComponent(props.changeset.changeset.id)}`"
						target="_blank"
						v-tooltip="i18n.t('changeset-results.openstreetmap-tooltip')"
					>OpenStreetMap <Icon icon="new-window" size="1em"></Icon></a>
				</div>
			</div>

			<div class="carousel-item" :class="{ active: carousel.tab === 1 }">
				<ChangesetFeatureInfo
					v-if="openFeature"
					:feature="openFeature"
					showBackButton
					:zoom="mapContext.zoom"
					@back="closeFeature()"
				></ChangesetFeatureInfo>
			</div>
		</div>
	</div>
</template>

<style lang="scss">
	.fm-changeset-results {
		display: flex;
		flex-direction: column;
		min-height: 0;

		.list-group-item {
			display: flex;
			align-items: center;

			> :first-child {
				flex-grow: 1;
			}

			> * + * {
				margin-left: 0.25rem;
			}

			span, a {
				display: inline-flex;
				align-items: center;
			}

			&:not(.active) {
				&.created > :first-child .fm-icon {
					color: #0c0;
				}

				&.deleted > :first-child .fm-icon {
					color: #f00;
				}

				&.modified > :first-child .fm-icon {
					color: #00f;
				}
			}
		}
	}
</style>