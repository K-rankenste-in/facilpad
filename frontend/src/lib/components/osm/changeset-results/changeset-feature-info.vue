<script setup lang="ts">
	import { renderOsmTag, type ChangesetFeature } from 'facilmap-utils';
	import { getChangesetFeatureLabel, getOsmObjectLabel } from './utils';
	import { useI18n } from '../../../utils/i18n';
	import Icon from '../ui/icon.vue';
	import ChangesetOldNew from './changeset-old-new.vue';
	import ZoomToObjectButton from '../ui/zoom-to-object-button.vue';
	import { getZoomDestinationForChangesetFeature } from '../../../utils/zoom';
	import { computed } from 'vue';
	import Coordinates from '../ui/coordinates.vue';
	import vTooltip from '../../../utils/tooltip';

	const props = withDefaults(defineProps<{
		feature: ChangesetFeature;
		showBackButton?: boolean;
		zoom?: number;
	}>(), {
		showBackButton: false
	});

	const emit = defineEmits<{
		back: [];
	}>();

	const i18n = useI18n();

	const label = computed(() => getChangesetFeatureLabel(props.feature));

	const zoomDestination = computed(() => getZoomDestinationForChangesetFeature(props.feature));

	const tags = computed(() => [...new Set([...Object.keys(props.feature.old?.tags ?? {}), ...Object.keys(props.feature.new?.tags ?? {})])].map((key) => ({
		key,
		oldValue: props.feature.old?.tags?.[key],
		newValue: props.feature.new?.tags?.[key]
	})));

	const members = computed(() => {
		if (props.feature.type === "relation") {
			const oldMembers = [...props.feature.old?.members ?? []];
			return [
				...(props.feature.new?.members ?? []).map((member) => {
					const oldIdx = oldMembers.findIndex((m) => m.type === member.type && m.ref === member.ref);
					const oldMember = oldIdx === -1 ? undefined : oldMembers.splice(oldIdx, 1)[0];
					return { oldValue: oldMember, newValue: member };
				}),
				...oldMembers.map((member) => ({ oldValue: member, newValue: undefined }))
			];
		} else {
			return [];
		}
	});
</script>

<template>
	<div class="fm-changeset-feature-info">
		<h2 class="text-break">
			<a v-if="showBackButton" href="javascript:" @click="emit('back')"><Icon icon="arrow-left"></Icon></a>
			{{label}}
		</h2>
		<dl class="fm-search-box-collapse-point fm-search-box-dl">
			<template v-if="feature.type === 'node'">
				<dt>{{i18n.t("common.coordinates")}}</dt>
				<dd>
					<ChangesetOldNew
						:oldValue="feature.old && { lat: feature.old.lat, lon: feature.old.lon }"
						:newValue="feature.new && { lat: feature.new.lat, lon: feature.new.lon }"
					>
						<template #default="slotProps">
							<Coordinates :point="slotProps.value" :zoom="props.zoom"></Coordinates>
						</template>
					</ChangesetOldNew>
				</dd>
			</template>

			<template v-for="t in tags" :key="t.key">
				<dt>{{t.key}}</dt>
				<dd class="text-break">
					<ChangesetOldNew :oldValue="t.oldValue" :newValue="t.newValue">
						<template #default="slotProps">
							<span v-html="renderOsmTag(t.key, slotProps.value)"></span>
						</template>
					</ChangesetOldNew>
				</dd>
			</template>

			<template v-if="members.length > 0">
				<dt>{{i18n.t("changeset-feature-info.members")}}</dt>
				<dd>
					<ul>
						{{/* eslint-disable-next-line vue/require-v-for-key */""}}
						<li v-for="member in members">
							<ChangesetOldNew
								:oldValue="member.oldValue && { type: member.oldValue.type, id: member.oldValue.ref }"
								:newValue="member.newValue && { type: member.newValue.type, id: member.newValue.ref }"
							>
								<template #default="slotProps">
									<a
										:href="`https://www.openstreetmap.org/${encodeURIComponent(slotProps.value.type)}/${encodeURIComponent(slotProps.value.id)}`"
										target="_blank"
										v-tooltip="i18n.t('changeset-feature-info.openstreetmap-tooltip')"
									>{{getOsmObjectLabel(slotProps.value.type, slotProps.value.id)}} <Icon icon="new-window" size="1em"></Icon></a>
								</template>
							</ChangesetOldNew>
							<template v-if="member.oldValue?.role || member.newValue?.role">
								{{" "}}(<ChangesetOldNew :oldValue="member.oldValue?.role" :newValue="member.newValue?.role"></ChangesetOldNew>)
							</template>
						</li>
					</ul>
				</dd>
			</template>
		</dl>

		<div class="btn-toolbar">
			<ZoomToObjectButton
				v-if="zoomDestination"
				:label="i18n.t('changeset-feature-info.zoom-to-feature-label')"
				size="sm"
				:destination="zoomDestination"
			></ZoomToObjectButton>

			<a
				class="btn btn-secondary btn-sm"
				:href="`https://www.openstreetmap.org/${encodeURIComponent(feature.type)}/${encodeURIComponent(feature.id)}`"
				target="_blank"
				v-tooltip="i18n.t('changeset-feature-info.openstreetmap-tooltip')"
			>OpenStreetMap <Icon icon="new-window" size="1em"></Icon></a>
		</div>
	</div>
</template>

<style lang="scss">
	.fm-changeset-feature-info {
		display: flex;
		flex-direction: column;
		min-height: 0;

		ul {
			list-style-type: none;

			&, li {
				margin-left: 0;
				padding-left: 0;
			}
		}

	}
</style>