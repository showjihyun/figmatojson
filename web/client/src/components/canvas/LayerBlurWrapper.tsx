/**
 * Konva Group that caches its children to a bitmap and applies
 * Konva.Filters.Blur — the only way to get a "layer blur" effect on
 * a tree of Konva shapes (Konva can't blur live shapes, only cached
 * bitmaps).
 *
 * Spec: docs/specs/web-render-fidelity-round9.spec.md §2
 *
 * Performance caveat: cache() rasterizes all descendants whenever
 * `radius` changes. Only nodes with an active LAYER_BLUR end up
 * inside this wrapper, so most documents pay nothing.
 */
import { useEffect, useRef } from 'react';
import { Group } from 'react-konva';
import Konva from 'konva';

interface LayerBlurWrapperProps {
  radius: number;
  children?: React.ReactNode;
}

export function LayerBlurWrapper({ radius, children }: LayerBlurWrapperProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = useRef<any>(null);

  useEffect(() => {
    const g = ref.current as Konva.Group | null;
    if (!g) return;
    // Re-cache + re-apply on every radius change. Konva caches the
    // current scene-graph state — calling it again replaces the
    // existing bitmap with a fresh one.
    g.cache();
    g.filters([Konva.Filters.Blur]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (g as any).blurRadius(radius);
  }, [radius]);

  return <Group ref={ref}>{children}</Group>;
}
