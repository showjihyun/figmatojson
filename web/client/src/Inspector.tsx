/**
 * Right-side Properties panel — Figma-like sectioned editor.
 *
 * Sections (shown when applicable):
 *   - Layer        : name, visible, opacity, rotation
 *   - Position/Size: X, Y, W, H, cornerRadius
 *   - Auto Layout  : direction, padding (T/R/B/L), gap, alignment
 *   - Fill         : color picker for first SOLID paint
 *   - Stroke       : color, weight, align
 *   - Text         : characters, family, weight, size, lineHeight, letterSpacing, align
 *
 * Each control debounces its patch (200ms) so dragging a slider doesn't spam
 * the backend, but every keystroke still ends up in message.json before save.
 */
import { useMemo, useState, useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { patchNode } from './api';

interface InspectorProps {
  page: any;
  sessionId: string;
  selectedGuid: string | null;
  onChange: () => void;
}

function findByGuid(root: any, guid: string): any | null {
  if (!root || typeof root !== 'object') return null;
  const g = root.guid;
  if (g && `${g.sessionID}:${g.localID}` === guid) return root;
  if (Array.isArray(root.children)) {
    for (const c of root.children) {
      const f = findByGuid(c, guid);
      if (f) return f;
    }
  }
  return null;
}

/** rgba 0..1 → "#RRGGBB" hex (drops alpha — handle via separate slider). */
function rgbaToHex(c?: { r?: number; g?: number; b?: number }): string {
  const r = Math.round(((c?.r ?? 0) * 255));
  const g = Math.round(((c?.g ?? 0) * 255));
  const b = Math.round(((c?.b ?? 0) * 255));
  const h = (n: number): string => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}
function hexToRgb01(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return { r: 0, g: 0, b: 0 };
  const i = parseInt(m[1]!, 16);
  return { r: ((i >> 16) & 0xff) / 255, g: ((i >> 8) & 0xff) / 255, b: (i & 0xff) / 255 };
}

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

export function Inspector({ page, sessionId, selectedGuid, onChange }: InspectorProps) {
  const node = useMemo(
    () => (selectedGuid ? findByGuid(page, selectedGuid) : null),
    [page, selectedGuid],
  );

  if (!selectedGuid) {
    return (
      <div style={{ padding: 16, color: '#888', fontSize: 12 }}>
        Click a shape on the canvas to inspect / edit.
      </div>
    );
  }
  if (!node) {
    return (
      <div style={{ padding: 16, color: '#c66', fontSize: 12 }}>
        Selected node {selectedGuid} not found in current page.
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        fontSize: 12,
      }}
    >
      <Header node={node} guid={selectedGuid} />
      <TabbedBody node={node} sessionId={sessionId} guid={selectedGuid} onChange={onChange} />
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
  const [tab, setTab] = useState<'properties' | 'json'>('properties');
  return (
    <>
      <div
        style={{
          display: 'flex',
          borderBottom: '1px solid #2a2a2a',
          background: '#181818',
          flexShrink: 0,
        }}
      >
        {(['properties', 'json'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              flex: 1,
              padding: '10px 12px',
              border: 'none',
              borderBottom: tab === t ? '2px solid #0a84ff' : '2px solid transparent',
              background: 'transparent',
              color: tab === t ? '#fff' : '#888',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              letterSpacing: 0.3,
              textTransform: 'uppercase',
            }}
          >
            {t === 'properties' ? 'Properties' : 'JSON'}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {tab === 'properties' ? (
          <>
            <Section title="Layer">
              <LayerSection node={node} sessionId={sessionId} guid={guid} onChange={onChange} />
            </Section>
            {/* Component Texts section — the primary entry point for editing
                text inside INSTANCE nodes (which have no clickable children
                on the canvas). Surface it FIRST under Layer so users can
                find it immediately when a component is selected. */}
            {node.type === 'INSTANCE' &&
              Array.isArray(node._componentTexts) &&
              node._componentTexts.length > 0 && (
                <Section title="Component Texts">
                  <ComponentTextsSection
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
          </>
        ) : (
          <JsonView node={node} />
        )}
      </div>
    </>
  );
}

// ─── Reusable bits ───────────────────────────────────────────────────────────

function Header({ node, guid }: { node: any; guid: string }) {
  return (
    <div
      style={{
        padding: '12px 16px',
        borderBottom: '1px solid #2a2a2a',
        background: '#181818',
        position: 'sticky',
        top: 0,
        zIndex: 1,
      }}
    >
      <div style={{ fontSize: 10, color: '#777', letterSpacing: 0.5 }}>
        {node.type} · {guid}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, marginTop: 3, color: '#eee' }}>
        {node.name ?? <span style={{ color: '#666' }}>(unnamed)</span>}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ borderBottom: '1px solid #2a2a2a' }}>
      <div
        style={{
          padding: '10px 16px 6px',
          fontSize: 10,
          color: '#888',
          letterSpacing: 0.7,
          textTransform: 'uppercase',
          fontWeight: 600,
        }}
      >
        {title}
      </div>
      <div style={{ padding: '0 12px 10px' }}>{children}</div>
    </div>
  );
}

function Row({ label, children, style }: { label: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', ...style }}>
      <div style={{ width: 60, color: '#888', fontSize: 11 }}>{label}</div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>{children}</div>
    </div>
  );
}

const inputStyle: CSSProperties = {
  background: '#0c0c0c',
  border: '1px solid #2c2c2c',
  borderRadius: 4,
  color: '#e8e8e8',
  padding: '5px 8px',
  fontSize: 12,
  fontFamily: 'inherit',
  outline: 'none',
  width: '100%',
  minWidth: 0,
};

function NumberInput({
  value,
  onCommit,
  step = 1,
  width,
  suffix,
}: {
  value: number | undefined;
  onCommit: (v: number) => void;
  step?: number;
  width?: number;
  suffix?: string;
}) {
  const [local, setLocal] = useState(value ?? 0);
  useEffect(() => {
    setLocal(value ?? 0);
  }, [value]);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        background: '#0c0c0c',
        border: '1px solid #2c2c2c',
        borderRadius: 4,
        padding: '0 6px',
        width: width ?? '100%',
      }}
    >
      <input
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
        style={{
          background: 'transparent',
          border: 'none',
          color: '#e8e8e8',
          padding: '5px 0',
          fontSize: 12,
          fontFamily: 'inherit',
          outline: 'none',
          width: '100%',
          minWidth: 0,
          MozAppearance: 'textfield' as never,
        }}
      />
      {suffix && <span style={{ color: '#666', fontSize: 11 }}>{suffix}</span>}
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
      <textarea
        value={local}
        rows={3}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => local !== value && onCommit(local)}
        style={{ ...inputStyle, resize: 'vertical', minHeight: 60, fontFamily: 'inherit' }}
      />
    );
  }
  return (
    <input
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
      style={inputStyle}
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
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
      <input
        type="color"
        value={hex}
        onChange={(e) => {
          const rgb = hexToRgb01(e.target.value);
          onCommit({ ...rgb, a: alpha });
        }}
        style={{
          width: 28,
          height: 28,
          padding: 0,
          border: '1px solid #2c2c2c',
          borderRadius: 4,
          background: 'transparent',
          cursor: 'pointer',
        }}
      />
      <input
        type="text"
        value={hex.toUpperCase().replace('#', '')}
        onChange={(e) => {
          const v = e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 6);
          if (v.length === 6) onCommit({ ...hexToRgb01(v), a: alpha });
        }}
        style={{ ...inputStyle, fontFamily: 'Menlo, Consolas, monospace', textTransform: 'uppercase', flex: 1 }}
      />
      <input
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
        style={{ ...inputStyle, width: 56, flex: 'none', textAlign: 'right' }}
      />
      <span style={{ color: '#666', fontSize: 11 }}>%</span>
    </div>
  );
}

function Select<T extends string | number>({
  value,
  options,
  onCommit,
}: {
  value: T | undefined;
  options: Array<{ label: string; value: T }>;
  onCommit: (v: T) => void;
}) {
  return (
    <select
      value={String(value ?? '')}
      onChange={(e) => {
        const opt = options.find((o) => String(o.value) === e.target.value);
        if (opt) onCommit(opt.value);
      }}
      style={inputStyle}
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
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
    <div style={{ display: 'flex', gap: 2, background: '#0c0c0c', border: '1px solid #2c2c2c', borderRadius: 4, padding: 2, width: '100%' }}>
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={String(o.value)}
            onClick={() => onCommit(o.value)}
            style={{
              flex: 1,
              padding: '4px 6px',
              fontSize: 11,
              border: 'none',
              borderRadius: 3,
              cursor: 'pointer',
              background: active ? '#0a84ff' : 'transparent',
              color: active ? 'white' : '#aaa',
            }}
          >
            {o.icon ?? o.label}
          </button>
        );
      })}
    </div>
  );
}

function usePatch(sessionId: string, guid: string, onChange: () => void) {
  const pending = useRef<Map<string, unknown>>(new Map());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return (field: string, value: unknown): void => {
    pending.current.set(field, value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const entries = [...pending.current.entries()];
      pending.current.clear();
      timer.current = null;
      for (const [f, v] of entries) {
        try {
          await patchNode(sessionId, guid, f, v);
        } catch (err) {
          console.error('patch failed', f, err);
        }
      }
      onChange();
    }, 220);
  };
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
            { label: '👁 Show', value: 'visible' },
            { label: '⊘ Hide', value: 'hidden' },
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
        <Select<string>
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
        <Select<string>
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
        <span style={{ color: '#888', fontSize: 11 }}>{first.type ?? 'unknown'} (not editable in PoC)</span>
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
        <Select<string>
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
  refs,
  sessionId,
  onChange,
}: {
  refs: ComponentTextRef[];
  sessionId: string;
  onChange: () => void;
}) {
  return (
    <>
      <div
        style={{
          fontSize: 10,
          color: '#888',
          padding: '0 4px 8px',
          lineHeight: 1.5,
        }}
      >
        Edit text inside this component. Changes apply to the master and may
        affect other instances of the same component.
      </div>
      {refs.map((r) => (
        <ComponentTextRow key={r.guid} item={r} sessionId={sessionId} onChange={onChange} />
      ))}
    </>
  );
}

function ComponentTextRow({
  item,
  sessionId,
  onChange,
}: {
  item: ComponentTextRef;
  sessionId: string;
  onChange: () => void;
}) {
  const [val, setVal] = useState(item.characters);
  useEffect(() => setVal(item.characters), [item.characters]);
  const dirty = val !== item.characters;
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '6px 4px',
        borderTop: '1px solid #1f1f1f',
      }}
    >
      <div style={{ fontSize: 10, color: '#888', display: 'flex', gap: 6, alignItems: 'center' }}>
        <span style={{ color: '#aaa', fontWeight: 600 }}>{item.name ?? 'Text'}</span>
        {item.path && <span style={{ color: '#555' }}>· {item.path}</span>}
        <span style={{ marginLeft: 'auto', fontFamily: 'Menlo, monospace', color: '#444' }}>
          {item.guid}
        </span>
      </div>
      <textarea
        value={val}
        rows={Math.min(4, Math.max(1, val.split('\n').length))}
        onChange={(e) => setVal(e.target.value)}
        style={{
          ...inputStyle,
          resize: 'vertical',
          minHeight: 30,
          fontFamily: 'inherit',
        }}
      />
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        {dirty && (
          <button
            onClick={() => setVal(item.characters)}
            style={{
              background: 'transparent',
              color: '#888',
              border: '1px solid #2c2c2c',
              padding: '4px 10px',
              borderRadius: 4,
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        )}
        <button
          onClick={async () => {
            if (!dirty) return;
            try {
              await patchNode(sessionId, item.guid, 'textData.characters', val);
              onChange();
            } catch (err) {
              alert(`Failed: ${(err as Error).message}`);
            }
          }}
          disabled={!dirty}
          style={{
            background: dirty ? '#0a84ff' : '#1c1c1c',
            color: dirty ? 'white' : '#555',
            border: 'none',
            padding: '4px 12px',
            borderRadius: 4,
            fontSize: 11,
            cursor: dirty ? 'pointer' : 'default',
            fontWeight: 600,
          }}
        >
          Apply
        </button>
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
      <Row label="Content" style={{ alignItems: 'flex-start' }}>
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
        <Select<string>
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
        <Select<string>
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
        <Select<string>
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
            { label: '⇤', value: 'LEFT' },
            { label: '↔', value: 'CENTER' },
            { label: '⇥', value: 'RIGHT' },
            { label: '⇿', value: 'JUSTIFIED' },
          ]}
          onCommit={(v) => patch('textAlignHorizontal', v)}
        />
      </Row>
      <Row label="V-Align">
        <ToggleButtons<string>
          value={node.textAlignVertical ?? 'TOP'}
          options={[
            { label: '⇈', value: 'TOP' },
            { label: '═', value: 'CENTER' },
            { label: '⇊', value: 'BOTTOM' },
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
    <div style={{ padding: 12 }}>
      <div
        style={{
          fontSize: 10,
          color: '#888',
          textTransform: 'uppercase',
          letterSpacing: 0.7,
          fontWeight: 600,
          marginBottom: 8,
          paddingLeft: 4,
        }}
      >
        Selected node JSON · click any property tab to edit
      </div>
      <pre
        style={{
          margin: 0,
          padding: 12,
          fontSize: 11.5,
          lineHeight: 1.55,
          fontFamily: 'Menlo, Consolas, "Cascadia Mono", monospace',
          background: '#0a0a0a',
          border: '1px solid #2a2a2a',
          borderRadius: 6,
          color: '#bbb',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
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
