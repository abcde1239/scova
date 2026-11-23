import { computed, ref, shallowRef, watch, type Ref } from 'vue';
import {
    canvasBounds,
    clampPosition,
    coordinateLimit,
    nodeHeight,
    nodeWidth,
    readCanvasPosition,
    type CanvasPoint,
} from '@/utils/workflow/canvas';

const minScale = 0.002;
const maxScale = 2;
const dragThreshold = 4;

export const canvasDirections = {
    ArrowUp: { x: 0, y: -1, label: '上', mark: '↑' },
    ArrowDown: { x: 0, y: 1, label: '下', mark: '↓' },
    ArrowLeft: { x: -1, y: 0, label: '左', mark: '←' },
    ArrowRight: { x: 1, y: 0, label: '右', mark: '→' },
};

export function canvasArrow(key: string) {
    return Object.hasOwn(canvasDirections, key)
        ? canvasDirections[key as keyof typeof canvasDirections]
        : undefined;
}

type Gesture = {
    id: number;
    target: HTMLElement;
    origin: CanvasPoint;
    camera: CanvasPoint;
    moved: boolean;
} & (
    | { mode: 'nodes'; positions: Record<string, CanvasPoint> }
    | { mode: 'pan'; clear: boolean }
    | { mode: 'select'; additive: boolean }
);

export function useWorkflowCanvasViewport(
    stage: Ref<HTMLElement | null>,
    positions: Readonly<Ref<Record<string, CanvasPoint>>>,
    nodeIds: () => string[],
    onMove: (positions: Record<string, CanvasPoint>) => boolean,
    onSelect: (ids: string[], additive: boolean) => void,
) {
    const scale = ref(1);
    const camera = ref<CanvasPoint>({ x: 0, y: 0 });
    const preview = shallowRef<Record<string, CanvasPoint>>({});
    const selectionBox = ref<{ left: number; top: number; width: number; height: number }>();
    const gestureMode = ref<Gesture['mode']>();
    const rendered = computed(() => ({ ...positions.value, ...preview.value }));
    let gesture: Gesture | undefined;
    let initialized = false;

    function fit() {
        const element = stage.value;
        if (!element?.clientWidth || !element.clientHeight) return;
        const points = nodeIds().flatMap((id) => {
            const point = readCanvasPosition(positions.value, id);
            return point ? [point] : [];
        });
        const bounds = canvasBounds(points);
        if (!bounds) {
            scale.value = 1;
            camera.value = { x: 0, y: 0 };
            return;
        }
        const margin = 48;
        scale.value = Math.max(
            minScale,
            Math.min(
                1,
                Math.max(1, element.clientWidth - 2 * margin) / bounds.width,
                Math.max(1, element.clientHeight - 2 * margin) / bounds.height,
            ),
        );
        camera.value = {
            x: (element.clientWidth - bounds.width * scale.value) / 2 - bounds.x * scale.value,
            y: (element.clientHeight - bounds.height * scale.value) / 2 - bounds.y * scale.value,
        };
        initialized = true;
    }

    watch(
        stage,
        (element, _, onCleanup) => {
            if (!element) return;
            fit();
            const observer = new ResizeObserver(() => {
                if (!initialized) fit();
            });
            observer.observe(element);
            onCleanup(() => {
                observer.disconnect();
                cancel();
            });
        },
        { flush: 'post' },
    );

    function pointAt(screen: CanvasPoint) {
        return {
            x: (screen.x - camera.value.x) / scale.value,
            y: (screen.y - camera.value.y) / scale.value,
        };
    }

    function localPoint(event: PointerEvent | DragEvent) {
        const rect = stage.value?.getBoundingClientRect();
        return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
    }

    function zoom(factor: number) {
        const element = stage.value;
        if (!element) return;
        const center = { x: element.clientWidth / 2, y: element.clientHeight / 2 };
        const point = pointAt(center);
        scale.value = Math.min(maxScale, Math.max(minScale, scale.value * factor));
        camera.value = { x: center.x - point.x * scale.value, y: center.y - point.y * scale.value };
    }

    function pan(delta: CanvasPoint) {
        camera.value = { x: camera.value.x + delta.x, y: camera.value.y + delta.y };
    }

    function reveal(id: string) {
        const point = readCanvasPosition(rendered.value, id);
        const element = stage.value;
        if (!point || !element?.clientWidth) return;
        const x = camera.value.x + point.x * scale.value;
        const y = camera.value.y + point.y * scale.value;
        if (
            x >= 8 &&
            y >= 8 &&
            x + nodeWidth * scale.value < element.clientWidth - 8 &&
            y + nodeHeight * scale.value < element.clientHeight - 8
        )
            return;
        camera.value = {
            x: element.clientWidth / 2 - (point.x + nodeWidth / 2) * scale.value,
            y: element.clientHeight / 2 - (point.y + nodeHeight / 2) * scale.value,
        };
    }

    function movedPositions(before: Record<string, CanvasPoint>, delta: CanvasPoint) {
        const points = Object.values(before);
        if (!points.length) return {};
        // Clamp the shared delta so a selection keeps its shape at the graph coordinate limit.
        const x = Math.min(
            coordinateLimit - Math.max(...points.map((point) => point.x)),
            Math.max(-coordinateLimit - Math.min(...points.map((point) => point.x)), delta.x),
        );
        const y = Math.min(
            coordinateLimit - Math.max(...points.map((point) => point.y)),
            Math.max(-coordinateLimit - Math.min(...points.map((point) => point.y)), delta.y),
        );
        return Object.fromEntries(
            Object.entries(before).map(([id, point]) => [
                id,
                clampPosition({ x: point.x + x, y: point.y + y }),
            ]),
        );
    }

    function getPositions(ids: Iterable<string>) {
        return Object.fromEntries(
            [...ids].flatMap((id) => {
                const point = readCanvasPosition(positions.value, id);
                return point ? [[id, point] as const] : [];
            }),
        );
    }

    function nudge(ids: Iterable<string>, direction: CanvasPoint, step = 16) {
        return onMove(
            movedPositions(getPositions(ids), { x: direction.x * step, y: direction.y * step }),
        );
    }

    function capture(
        event: PointerEvent,
        options:
            | Pick<Extract<Gesture, { mode: 'nodes' }>, 'mode' | 'positions'>
            | Pick<Extract<Gesture, { mode: 'select' }>, 'mode' | 'additive'>
            | Pick<Extract<Gesture, { mode: 'pan' }>, 'mode' | 'clear'>,
    ) {
        if (gesture) return;
        const target = event.currentTarget as HTMLElement;
        target.setPointerCapture(event.pointerId);
        gesture = {
            id: event.pointerId,
            target,
            origin: localPoint(event),
            camera: camera.value,
            moved: false,
            ...options,
        };
        gestureMode.value = options.mode;
    }

    function startNodes(event: PointerEvent, ids: Iterable<string>) {
        if (event.button !== 0 || !event.isPrimary) return;
        (event.currentTarget as HTMLElement).focus({ preventScroll: true });
        capture(event, { mode: 'nodes', positions: getPositions(ids) });
    }

    function startStage(event: PointerEvent, select: boolean) {
        if (![0, 1].includes(event.button) || !event.isPrimary || gesture) return;
        event.preventDefault();
        stage.value?.focus({ preventScroll: true });
        capture(
            event,
            select && event.button === 0
                ? { mode: 'select', additive: event.shiftKey || event.ctrlKey || event.metaKey }
                : { mode: 'pan', clear: event.button === 0 },
        );
    }

    function move(event: PointerEvent) {
        if (gesture?.id !== event.pointerId) return;
        const origin = gesture.origin;
        const point = localPoint(event);
        const delta = { x: point.x - origin.x, y: point.y - origin.y };
        if (!gesture.moved && Math.hypot(delta.x, delta.y) < dragThreshold) return;
        gesture.moved = true;
        if (gesture.mode === 'nodes')
            preview.value = movedPositions(gesture.positions, {
                x: delta.x / scale.value,
                y: delta.y / scale.value,
            });
        if (gesture.mode === 'pan')
            camera.value = { x: gesture.camera.x + delta.x, y: gesture.camera.y + delta.y };
        if (gesture.mode === 'select') {
            selectionBox.value = {
                left: Math.min(origin.x, point.x),
                top: Math.min(origin.y, point.y),
                width: Math.abs(delta.x),
                height: Math.abs(delta.y),
            };
        }
    }

    function finish(event: PointerEvent) {
        if (gesture?.id !== event.pointerId) return;
        move(event);
        if (gesture.mode === 'nodes' && gesture.moved) onMove(preview.value);
        if (gesture.mode === 'pan' && gesture.clear && !gesture.moved) onSelect([], false);
        if (gesture.mode === 'select') {
            const box = selectionBox.value;
            const ids = nodeIds().filter((id) => {
                const point = readCanvasPosition(positions.value, id);
                if (!point || !box) return false;
                const x = camera.value.x + point.x * scale.value;
                const y = camera.value.y + point.y * scale.value;
                return (
                    x < box.left + box.width &&
                    y < box.top + box.height &&
                    x + nodeWidth * scale.value > box.left &&
                    y + nodeHeight * scale.value > box.top
                );
            });
            onSelect(ids, gesture.additive);
        }
        cancel();
    }

    function cancel(event?: PointerEvent) {
        if (event && gesture?.id !== event.pointerId) return;
        const current = gesture;
        gesture = undefined;
        if (current?.target.hasPointerCapture(current.id))
            current.target.releasePointerCapture(current.id);
        gestureMode.value = undefined;
        preview.value = {};
        selectionBox.value = undefined;
    }

    return {
        camera,
        scale,
        rendered,
        selectionBox,
        gestureMode,
        pointAt,
        localPoint,
        fit,
        zoom,
        pan,
        reveal,
        nudge,
        startNodes,
        startStage,
        move,
        finish,
        cancel,
    };
}
