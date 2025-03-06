<script setup lang="ts" generic="T">
import { isEqual } from 'lodash-es';
import { computed } from 'vue';

	const props = defineProps<{
		oldValue: T | undefined;
		newValue: T | undefined;
	}>();

	defineSlots<{
		default(props: { value: T }): any;
	}>();

	const unchangedValue = computed(() => props.oldValue && props.newValue && isEqual(props.oldValue, props.newValue) ? props.oldValue : undefined);
	const deletedValue = computed(() => unchangedValue.value ? undefined : props.oldValue);
	const createdValue = computed(() => unchangedValue.value ? undefined : props.newValue);

	const className = computed(() => (
		!props.oldValue ? "created" :
		!props.newValue ? "deleted" :
		"modified"
	));
</script>

<template>
	<span class="fm-changeset-old-new" :class="className">
		<span v-if="unchangedValue" class="unchanged">
			<slot :value="unchangedValue">{{unchangedValue}}</slot>
		</span>

		<span v-if="deletedValue" class="deleted">
			<slot :value="deletedValue">{{deletedValue}}</slot>
		</span>

		<span v-if="createdValue" class="created">
			<slot :value="createdValue">{{createdValue}}</slot>
		</span>
	</span>
</template>

<style lang="scss">
	.fm-changeset-old-new {
		.deleted {
			background-color: #fcc;

			&, > span, > span > span {
				text-decoration: line-through;
			}
		}

		.created {
			background-color: #cfc;
		}
	}
</style>