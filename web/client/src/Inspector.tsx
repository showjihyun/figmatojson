/**
 * Right-side Properties panel — Figma-like sectioned editor.
 *
 * Sections (shown when applicable):
 *   - Layer        : name, visible, opacity
 *   - Position/Size: X, Y, W, H, cornerRadius
 *   - Auto Layout  : direction, padding (T/R/B/L), gap, alignment
 *   - Fill         : color picker for first SOLID paint
 *   - Stroke       : color, weight, align
 *   - Text         : characters, family, weight, size, lineHeight, letterSpacing, align
 *
 * Each control debounces its patch (~220ms) so dragging a slider doesn't spam
 * the backend, but every keystroke still ends up in message.json before save.
 */
import { useMemo, useState, useEffect, useRef, type ReactNode } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { documentService } from '@/services';
import { usePatch } from './hooks/usePatch';
import { rgbaToHex, hexToRgb01 } from '@core/domain/color';
import { findById } from '@core/domain/tree';
import { variantLabelText } from './lib/variantLabel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select as ShadSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

interface InspectorProps {
  page: any;
  sessionId: string;
  selectedGuid: string | null;
  selectedCount?: number;
  onChange: () => void;
}

// `findByGuid` here used to traverse via the raw `guid` object; the core
// `findById` traverses by the precomputed `id` string. The page tree this
// Inspector reads always has `id = guidStr(guid)` set during decode, so the
// two are equivalent in practice — alias kept for callers below.
const findByGuid = findById;

// `rgbaToHex` and `hexToRgb01` live in `@core/domain/color.ts` now.

const FONT_WEIGHT_STYLES = [
  { label: 'Thin', value: 'Thin' },
  { label: 'Light', value: 'Light' },
  { label: 'Regular', value: 'Regular' },
  { label: 'Medium', value: 'Medium' },
  { label: 'SemiBold', value: 'SemiBold' },
  { label: 'Bold', value: 'Bold' },
  { label: 'ExtraBold', value: 'ExtraBold' },
  { label: 'Black', value: 'Black' },
];

export function Inspector({ page, sessionId, selectedGuid, selectedCount, onChange }: InspectorProps) {
  const node = useMemo(
    () => (selectedGuid ? findByGuid(page, selectedGuid) : null),
    [page, selectedGuid],
  );

  if (!selectedGuid && (selectedCount ?? 0) === 0) {
    return (
      <div className="p-4 text-sm leading-relaxed text-muted-foreground">
        Click a shape on the canvas to inspect / edit.
        <div className="mt-1 text-xs text-muted-foreground/70">
          Shift+click to select multiple nodes.
        </div>
      </div>
    );
  }
  if (!selectedGuid && (selectedCount ?? 0) > 1) {
    return (
      <div className="p-4 text-sm leading-relaxed">
        <div className="mb-2 text-base font-semibold text-foreground">
          {selectedCount} nodes selected
        </div>
        <div className="text-muted-foreground">
          Drag any of them on the canvas to move all selected nodes together.
        </div>
        <div className="mt-2 text-xs text-muted-foreground/70">
          Per-property editing requires a single-node selection — Shift+click extras to deselect, or
          click empty canvas to clear.
        </div>
      </div>
    );
  }
  if (!node) {
    return (
      <div className="p-4 text-sm text-destructive">
        Selected node {selectedGuid} not found in current page.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col text-sm">
      <Header node={node} guid={selectedGuid!} />
      <TabbedBody node={node} sessionId={sessionId} guid={selectedGuid!} onChange={onChange} />
    </div>
  );
}

function TabbedBody({
  node,
  sessionId,
  guid,
  onChange,
}: {
  node: any;
  sessionId: string;
  guid: string;
  onChange: () => void;
}) {
  return (
    <Tabs defaultValue="properties" className="flex min-h-0 flex-1 flex-col">
      <div className="flex-shrink-0 border-b border-border bg-card px-3 py-2">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="properties">Properties</TabsTrigger>
          <TabsTrigger value="json">JSON</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="properties" className="m-0 flex-1 overflow-auto">
        <Section title="Layer">
          <LayerSection node={node} sessionId={sessionId} guid={guid} onChange={onChange} />
        </Section>
        {/* Component Texts section — primary entry point for editing
            text inside INSTANCE nodes. Surface it FIRST under Layer so users
            can find it immediately when a component is selected. */}
        {node.type === 'INSTANCE' &&
          Array.isArray(node._componentTexts) &&
          node._componentTexts.length > 0 && (
            <Section title="Component Texts">
              <ComponentTextsSection
                instanceGuid={guid}
                instanceOverrides={(node._instanceOverrides ?? {}) as Record<string, string>}
                refs={node._componentTexts}
                sessionId={sessionId}
                onChange={onChange}
              />
            </Section>
          )}
        <Section title="Position & Size">
          <PositionSection node={node} sessionId={sessionId} guid={guid} onChange={onChange} />
        </Section>
        {node.stackMode && node.stackMode !== 'NONE' && node.stackMode !== 'GRID' && (
          <Section title="Auto Layout">
            <AutoLayoutSection node={node} sessionId={sessionId} guid={guid} onChange={onChange} />
          </Section>
        )}
        {Array.isArray(node.fillPaints) && node.fillPaints.length > 0 && (
          <Section title="Fill">
            <FillSection node={node} sessionId={sessionId} guid={guid} onChange={onChange} />
          </Section>
        )}
        {typeof node.strokeWeight === 'number' && node.strokeWeight > 0 && (
          <Section title="Stroke">
            <StrokeSection node={node} sessionId={sessionId} guid={guid} onChange={onChange} />
          </Section>
        )}
        {node.type === 'TEXT' && (
          <Section title="Text">
            <TextSection node={node} sessionId={sessionId} guid={guid} onChange={onChange} />
          </Section>
        )}
      </TabsContent>
      <TabsContent value="json" className="m-0 flex-1 overflow-auto">
        <JsonView node={node} />
      </TabsContent>
    </Tabs>
  );
}

// ─── Reusable bits ───────────────────────────────────────────────────────────

function Header({ node, guid }: { node: any; guid: string }) {
  return (
    <div className="sticky top-0 z-10 flex-shrink-0 border-b border-border bg-card px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
        {node.type} <span className="opacity-60">· {guid}</span>
      </div>
      <div className="mt-1 text-sm font-semibold text-foreground">
        {/* Round 14 — strip variant `prop=` prefixes (e.g. "size=XL, State=default,
            Type=primary" → "XL, default, primary"). variantLabelText is a
            no-op for non-variant names; null only when name is missing. */}
        {variantLabelText(node.name) ?? <span className="text-muted-foreground">(unnamed)</span>}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-b border-border">
      <div className="px-4 pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <div className="px-3 pb-3">{children}</div>
    </div>
  );
}

function Row({ label, children, align }: { label: string; children: ReactNode; align?: 'top' }) {
  return (
    <div
      className={cn(
        'flex gap-2 py-1',
        align === 'top' ? 'items-start' : 'items-center',
      )}
    >
      <div className="w-16 shrink-0 text-xs text-muted-foreground">{label}</div>
      <div className="flex flex-1 items-center gap-1.5">{children}</div>
    </div>
  );
}

function NumberInput({
  value,
  onCommit,
  step = 1,
  suffix,
}: {
  value: number | undefined;
  onCommit: (v: number) => void;
  step?: number;
  suffix?: string;
}) {
  const [local, setLocal] = useState(value ?? 0);
  useEffect(() => {
    setLocal(value ?? 0);
  }, [value]);
  return (
    <div className="relative flex w-full items-center">
      <Input
        type="number"
        step={step}
        value={Number.isFinite(local) ? local : 0}
        onChange={(e) => setLocal(parseFloat(e.target.value || '0'))}
        onBlur={() => {
          if (local !== value) onCommit(local);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setLocal(value ?? 0);
            (e.target as HTMLInputElement).blur();
          }
        }}
        className={cn('h-8 text-sm tabular-nums', suffix && 'pr-7')}
      />
      {suffix && (
        <span className="pointer-events-none absolute right-2 text-xs text-muted-foreground">
          {suffix}
        </span>
      )}
    </div>
  );
}

function TextInput({
  value,
  onCommit,
  multiline,
}: {
  value: string;
  onCommit: (v: string) => void;
  multiline?: boolean;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  if (multiline) {
    return (
      <Textarea
        value={local}
        rows={3}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => local !== value && onCommit(local)}
        className="min-h-[60px] resize-y text-sm"
      />
    );
  }
  return (
    <Input
      type="text"
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => local !== value && onCommit(local)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setLocal(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
      className="h-8 text-sm"
    />
  );
}

function ColorInput({
  value,
  onCommit,
}: {
  value: { r?: number; g?: number; b?: number; a?: number } | undefined;
  onCommit: (v: { r: number; g: number; b: number; a: number }) => void;
}) {
  const hex = rgbaToHex(value);
  const alpha = value?.a ?? 1;
  return (
    <div className="flex w-full items-center gap-1.5">
      <input
        type="color"
        value={hex}
        onChange={(e) => {
          const rgb = hexToRgb01(e.target.value);
          onCommit({ ...rgb, a: alpha });
        }}
        className="h-8 w-9 cursor-pointer rounded-md border border-input bg-transparent p-0.5"
      />
      <Input
        type="text"
        value={hex.toUpperCase().replace('#', '')}
        onChange={(e) => {
          const v = e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 6);
          if (v.length === 6) onCommit({ ...hexToRgb01(v), a: alpha });
        }}
        className="h-8 flex-1 font-mono text-xs uppercase tracking-tight"
      />
      <div className="relative flex items-center">
        <Input
          type="number"
          min={0}
          max={100}
          value={Math.round(alpha * 100)}
          onChange={(e) => {
            const a = Math.max(0, Math.min(100, parseFloat(e.target.value || '0'))) / 100;
            onCommit({
              r: value?.r ?? 0,
              g: value?.g ?? 0,
              b: value?.b ?? 0,
              a,
            });
          }}
          className="h-8 w-20 pr-6 text-right tabular-nums"
        />
        <span className="pointer-events-none absolute right-2 text-xs text-muted-foreground">%</span>
      </div>
    </div>
  );
}

function Dropdown<T extends string | number>({
  value,
  options,
  onCommit,
}: {
  value: T | undefined;
  options: Array<{ label: string; value: T }>;
  onCommit: (v: T) => void;
}) {
  // Radix Select treats value="" as "uncontrolled" — passing one would silently
  // blank the trigger. Pass `undefined` for missing values so the placeholder
  // shows instead, and only become controlled once the user picks something.
  return (
    <ShadSelect
      value={value !== undefined ? String(value) : undefined}
      onValueChange={(v) => {
        const opt = options.find((o) => String(o.value) === v);
        if (opt) onCommit(opt.value);
      }}
    >
      <SelectTrigger className="h-8 w-full text-sm">
        <SelectValue placeholder="—" />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={String(o.value)} value={String(o.value)}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </ShadSelect>
  );
}

function ToggleButtons<T extends string>({
  value,
  options,
  onCommit,
}: {
  value: T | undefined;
  options: Array<{ label: string; value: T; icon?: ReactNode }>;
  onCommit: (v: T) => void;
}) {
  return (
    <div className="flex w-full gap-0.5 rounded-md border border-input bg-background p-0.5">
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            type="button"
            key={String(o.value)}
            onClick={() => onCommit(o.value)}
            className={cn(
              'flex-1 rounded px-2 py-1 text-xs font-medium transition-colors',
              active
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {o.icon ?? o.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Section bodies ──────────────────────────────────────────────────────────

interface SectionProps {
  node: any;
  sessionId: string;
  guid: string;
  onChange: () => void;
}

function LayerSection({ node, sessionId, guid, onChange }: SectionProps) {
  const patch = usePatch(sessionId, guid, onChange);
  return (
    <>
      <Row label="Name">
        <TextInput value={node.name ?? ''} onCommit={(v) => patch('name', v)} />
      </Row>
      <Row label="Visible">
        <ToggleButtons<string>
          value={node.visible === false ? 'hidden' : 'visible'}
          options={[
            { label: 'Show', value: 'visible', icon: <span className="inline-flex items-center gap-1"><Eye className="h-3.5 w-3.5" />Show</span> },
            { label: 'Hide', value: 'hidden', icon: <span className="inline-flex items-center gap-1"><EyeOff className="h-3.5 w-3.5" />Hide</span> },
          ]}
          onCommit={(v) => patch('visible', v === 'visible')}
        />
      </Row>
      <Row label="Opacity">
        <NumberInput
          value={Math.round((node.opacity ?? 1) * 100)}
          step={1}
          suffix="%"
          onCommit={(v) => patch('opacity', Math.max(0, Math.min(100, v)) / 100)}
        />
      </Row>
    </>
  );
}

function PositionSection({ node, sessionId, guid, onChange }: SectionProps) {
  const patch = usePatch(sessionId, guid, onChange);
  const tx = node.transform?.m02 ?? 0;
  const ty = node.transform?.m12 ?? 0;
  const w = node.size?.x ?? 0;
  const h = node.size?.y ?? 0;
  return (
    <>
      <Row label="Position">
        <NumberInput value={tx} onCommit={(v) => patch('transform.m02', v)} />
        <NumberInput value={ty} onCommit={(v) => patch('transform.m12', v)} />
      </Row>
      <Row label="Size">
        <NumberInput value={w} onCommit={(v) => patch('size.x', v)} />
        <NumberInput value={h} onCommit={(v) => patch('size.y', v)} />
      </Row>
      {(node.type === 'FRAME' ||
        node.type === 'ROUNDED_RECTANGLE' ||
        node.type === 'RECTANGLE' ||
        node.type === 'INSTANCE' ||
        node.type === 'COMPONENT' ||
        node.type === 'SYMBOL') && (
        <Row label="Corner">
          <NumberInput
            value={node.cornerRadius ?? 0}
            onCommit={(v) => patch('cornerRadius', v)}
          />
        </Row>
      )}
    </>
  );
}

function AutoLayoutSection({ node, sessionId, guid, onChange }: SectionProps) {
  const patch = usePatch(sessionId, guid, onChange);
  const padTop = node.stackPaddingTop ?? node.stackVerticalPadding ?? 0;
  const padRight = node.stackPaddingRight ?? node.stackHorizontalPadding ?? 0;
  const padBottom = node.stackPaddingBottom ?? node.stackVerticalPadding ?? 0;
  const padLeft = node.stackPaddingLeft ?? node.stackHorizontalPadding ?? 0;
  return (
    <>
      <Row label="Direction">
        <ToggleButtons<string>
          value={node.stackMode}
          options={[
            { label: '→ H', value: 'HORIZONTAL' },
            { label: '↓ V', value: 'VERTICAL' },
          ]}
          onCommit={(v) => patch('stackMode', v)}
        />
      </Row>
      <Row label="Gap">
        <NumberInput value={node.stackSpacing ?? 0} onCommit={(v) => patch('stackSpacing', v)} />
      </Row>
      <Row label="Pad T/R">
        <NumberInput value={padTop} onCommit={(v) => patch('stackPaddingTop', v)} />
        <NumberInput value={padRight} onCommit={(v) => patch('stackPaddingRight', v)} />
      </Row>
      <Row label="Pad B/L">
        <NumberInput value={padBottom} onCommit={(v) => patch('stackPaddingBottom', v)} />
        <NumberInput value={padLeft} onCommit={(v) => patch('stackPaddingLeft', v)} />
      </Row>
      <Row label="Align">
        <Dropdown<string>
          value={node.stackPrimaryAlignItems}
          options={[
            { label: 'Start', value: 'MIN' },
            { label: 'Center', value: 'CENTER' },
            { label: 'End', value: 'MAX' },
            { label: 'Space Between', value: 'SPACE_BETWEEN' },
          ]}
          onCommit={(v) => patch('stackPrimaryAlignItems', v)}
        />
      </Row>
      <Row label="Counter">
        <Dropdown<string>
          value={node.stackCounterAlignItems}
          options={[
            { label: 'Start', value: 'MIN' },
            { label: 'Center', value: 'CENTER' },
            { label: 'End', value: 'MAX' },
            { label: 'Stretch', value: 'STRETCH' },
          ]}
          onCommit={(v) => patch('stackCounterAlignItems', v)}
        />
      </Row>
    </>
  );
}

function FillSection({ node, sessionId, guid, onChange }: SectionProps) {
  const patch = usePatch(sessionId, guid, onChange);
  const first = (node.fillPaints?.[0] ?? null) as
    | { type?: string; color?: { r?: number; g?: number; b?: number; a?: number }; visible?: boolean; opacity?: number }
    | null;
  if (!first) return null;
  if (first.type !== 'SOLID') {
    return (
      <Row label="Type">
        <span className="text-xs text-muted-foreground">{first.type ?? 'unknown'} (not editable in PoC)</span>
      </Row>
    );
  }
  return (
    <>
      <Row label="Color">
        <ColorInput
          value={first.color}
          onCommit={(c) => {
            // Patch all 4 channels at once via separate calls (debounced together)
            patch('fillPaints[0].color.r', c.r);
            patch('fillPaints[0].color.g', c.g);
            patch('fillPaints[0].color.b', c.b);
            patch('fillPaints[0].color.a', c.a);
          }}
        />
      </Row>
      <Row label="Layer α">
        <NumberInput
          value={Math.round((first.opacity ?? 1) * 100)}
          suffix="%"
          onCommit={(v) => patch('fillPaints[0].opacity', Math.max(0, Math.min(100, v)) / 100)}
        />
      </Row>
    </>
  );
}

function StrokeSection({ node, sessionId, guid, onChange }: SectionProps) {
  const patch = usePatch(sessionId, guid, onChange);
  const first = (node.strokePaints?.[0] ?? null) as
    | { type?: string; color?: { r?: number; g?: number; b?: number; a?: number }; opacity?: number }
    | null;
  return (
    <>
      <Row label="Weight">
        <NumberInput
          value={node.strokeWeight ?? 1}
          step={0.5}
          onCommit={(v) => patch('strokeWeight', Math.max(0, v))}
        />
      </Row>
      <Row label="Align">
        <Dropdown<string>
          value={node.strokeAlign ?? 'CENTER'}
          options={[
            { label: 'Inside', value: 'INSIDE' },
            { label: 'Center', value: 'CENTER' },
            { label: 'Outside', value: 'OUTSIDE' },
          ]}
          onCommit={(v) => patch('strokeAlign', v)}
        />
      </Row>
      {first?.type === 'SOLID' && (
        <Row label="Color">
          <ColorInput
            value={first.color}
            onCommit={(c) => {
              patch('strokePaints[0].color.r', c.r);
              patch('strokePaints[0].color.g', c.g);
              patch('strokePaints[0].color.b', c.b);
              patch('strokePaints[0].color.a', c.a);
            }}
          />
        </Row>
      )}
    </>
  );
}

interface ComponentTextRef {
  guid: string;
  name?: string;
  path: string;
  characters: string;
}

function ComponentTextsSection({
  instanceGuid,
  instanceOverrides,
  refs,
  sessionId,
  onChange,
}: {
  instanceGuid: string;
  instanceOverrides: Record<string, string>;
  refs: ComponentTextRef[];
  sessionId: string;
  onChange: () => void;
}) {
  // Per-component default mode — most users want INSTANCE-only edits
  // (Figma's default behavior). Master mode is opt-in.
  const [mode, setMode] = useState<'instance' | 'master'>('instance');
  return (
    <>
      <div className="px-1 pb-2 text-xs leading-relaxed text-muted-foreground">
        {mode === 'instance' ? (
          <>
            <strong className="text-emerald-400">Instance override:</strong> changes apply only to
            this instance. Master and other instances stay intact.
          </>
        ) : (
          <>
            <strong className="text-orange-400">Master:</strong> changes propagate to <em>all</em>{' '}
            instances of this component.
          </>
        )}
      </div>
      <div className="px-1 pb-2">
        <ToggleButtons<'instance' | 'master'>
          value={mode}
          options={[
            { label: 'Override This', value: 'instance' },
            { label: 'Edit Master', value: 'master' },
          ]}
          onCommit={setMode}
        />
      </div>
      {refs.map((r) => (
        <ComponentTextRow
          key={r.guid}
          item={r}
          mode={mode}
          instanceGuid={instanceGuid}
          override={instanceOverrides[r.guid]}
          sessionId={sessionId}
          onChange={onChange}
        />
      ))}
    </>
  );
}

export function ComponentTextRow({
  item,
  mode,
  instanceGuid,
  override,
  sessionId,
  onChange,
}: {
  item: ComponentTextRef;
  mode: 'instance' | 'master';
  instanceGuid: string;
  override: string | undefined;
  sessionId: string;
  onChange: () => void;
}) {
  // The displayed value: in instance mode, prefer the override if any.
  const displayed = mode === 'instance' && typeof override === 'string' ? override : item.characters;
  const [val, setVal] = useState(displayed);
  // Track whether the user has typed since the last sync. Without this guard,
  // any sibling row Apply (or mode toggle) re-renders this row with a fresh
  // `displayed` value, and the effect would clobber the user's unsaved edit.
  const userTouched = useRef(false);
  useEffect(() => {
    if (!userTouched.current) setVal(displayed);
  }, [displayed]);
  const dirty = val !== displayed;
  const overridden = typeof override === 'string';
  return (
    <div className="flex flex-col gap-1.5 border-t border-border px-1 py-2 first:border-t-0">
      <div className="flex items-center gap-1.5 text-xs">
        <span className="font-semibold text-foreground">{item.name ?? 'Text'}</span>
        {item.path && <span className="text-muted-foreground/70">· {item.path}</span>}
        {overridden && (
          <span className="rounded bg-emerald-950 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-emerald-300">
            override
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] text-muted-foreground/60">{item.guid}</span>
      </div>
      <Textarea
        value={val}
        rows={Math.min(4, Math.max(1, val.split('\n').length))}
        onChange={(e) => {
          userTouched.current = true;
          setVal(e.target.value);
        }}
        className="min-h-[36px] resize-y text-sm"
      />
      <div className="flex justify-end gap-1.5">
        {dirty && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              userTouched.current = false;
              setVal(displayed);
            }}
          >
            Cancel
          </Button>
        )}
        <Button
          variant={mode === 'master' ? 'destructive' : 'default'}
          size="sm"
          disabled={!dirty}
          onClick={async () => {
            if (!dirty) return;
            try {
              if (mode === 'instance') {
                await documentService.setInstanceTextOverride(sessionId, instanceGuid, item.guid, val);
              } else {
                await documentService.patch(sessionId, item.guid, 'textData.characters', val);
              }
              userTouched.current = false;
              onChange();
            } catch (err) {
              alert(`Failed: ${(err as Error).message}`);
            }
          }}
        >
          Apply{mode === 'master' ? ' to Master' : ''}
        </Button>
      </div>
    </div>
  );
}

function TextSection({ node, sessionId, guid, onChange }: SectionProps) {
  const patch = usePatch(sessionId, guid, onChange);
  const family = node.fontName?.family ?? '';
  const style = node.fontName?.style ?? 'Regular';
  return (
    <>
      <Row label="Content" align="top">
        <TextInput
          value={node.textData?.characters ?? ''}
          multiline
          onCommit={(v) => patch('textData.characters', v)}
        />
      </Row>
      <Row label="Family">
        <TextInput value={family} onCommit={(v) => patch('fontName.family', v)} />
      </Row>
      <Row label="Weight">
        <Dropdown<string>
          value={style}
          options={FONT_WEIGHT_STYLES}
          onCommit={(v) => patch('fontName.style', v)}
        />
      </Row>
      <Row label="Size">
        <NumberInput value={node.fontSize ?? 12} step={1} onCommit={(v) => patch('fontSize', v)} />
      </Row>
      <Row label="L Height">
        <NumberInput
          value={node.lineHeight?.value ?? 0}
          step={1}
          onCommit={(v) => patch('lineHeight.value', v)}
        />
        <Dropdown<string>
          value={node.lineHeight?.units ?? 'PERCENT'}
          options={[
            { label: '%', value: 'PERCENT' },
            { label: 'px', value: 'PIXELS' },
            { label: 'raw', value: 'RAW' },
          ]}
          onCommit={(v) => patch('lineHeight.units', v)}
        />
      </Row>
      <Row label="Letter">
        <NumberInput
          value={node.letterSpacing?.value ?? 0}
          step={0.1}
          onCommit={(v) => patch('letterSpacing.value', v)}
        />
        <Dropdown<string>
          value={node.letterSpacing?.units ?? 'PERCENT'}
          options={[
            { label: '%', value: 'PERCENT' },
            { label: 'px', value: 'PIXELS' },
            { label: 'raw', value: 'RAW' },
          ]}
          onCommit={(v) => patch('letterSpacing.units', v)}
        />
      </Row>
      <Row label="Align">
        <ToggleButtons<string>
          value={node.textAlignHorizontal ?? 'LEFT'}
          options={[
            { label: 'L', value: 'LEFT' },
            { label: 'C', value: 'CENTER' },
            { label: 'R', value: 'RIGHT' },
            { label: 'J', value: 'JUSTIFIED' },
          ]}
          onCommit={(v) => patch('textAlignHorizontal', v)}
        />
      </Row>
      <Row label="V-Align">
        <ToggleButtons<string>
          value={node.textAlignVertical ?? 'TOP'}
          options={[
            { label: 'Top', value: 'TOP' },
            { label: 'Mid', value: 'CENTER' },
            { label: 'Btm', value: 'BOTTOM' },
          ]}
          onCommit={(v) => patch('textAlignVertical', v)}
        />
      </Row>
    </>
  );
}

function JsonView({ node }: { node: any }) {
  const stripped = strip(node);
  const json = JSON.stringify(stripped, null, 2);
  return (
    <div className="p-3">
      <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Selected node JSON · click any property tab to edit
      </div>
      <pre
        className="m-0 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-[#0a0a0a] p-3 font-mono text-[11.5px] leading-snug text-muted-foreground"
        dangerouslySetInnerHTML={{ __html: highlightJson(json) }}
      />
    </div>
  );
}

/**
 * Tiny JSON syntax highlighter — no deps.
 * Color scheme aligned with the dark theme of the editor.
 */
function highlightJson(json: string): string {
  const escape = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escaped = escape(json);
  const KEY = '#7eb6ff';     // light blue
  const STR = '#a3e3a3';     // soft green
  const NUM = '#ffb86c';     // orange
  const BOOL = '#ff79c6';    // pink (true/false/null)
  const PUNC = '#666';       // braces / brackets / commas
  return escaped.replace(
    /("(?:[^"\\]|\\.)*"\s*:)|("(?:[^"\\]|\\.)*")|(\b-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?\b)|(\btrue|false|null\b)|([{}[\],])/g,
    (_m, key, str, num, bool, punc) => {
      if (key) return `<span style="color:${KEY}">${key}</span>`;
      if (str) return `<span style="color:${STR}">${str}</span>`;
      if (num) return `<span style="color:${NUM}">${num}</span>`;
      if (bool) return `<span style="color:${BOOL}">${bool}</span>`;
      if (punc) return `<span style="color:${PUNC}">${punc}</span>`;
      return _m;
    },
  );
}

function strip(node: any): any {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(strip);
  const out: any = {};
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (k === 'children') {
      out[k] = `<${(v as any[])?.length ?? 0} children>`;
    } else if (k === 'derivedSymbolData' || k === 'fillGeometry' || k === 'strokeGeometry') {
      out[k] = `<elided>`;
    } else if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      typeof (v as any).__bytes === 'string'
    ) {
      out[k] = `<bytes>`;
    } else if (v && typeof v === 'object') {
      out[k] = strip(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
