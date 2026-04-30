# JSON → .fig 변환 가능성 검토

작성일: 2026-04-30

## TL;DR

**가능**: 단, 어떤 JSON을 입력으로 사용하느냐에 따라 난이도가 크게 다르다.

| 입력 JSON | 가능 여부 | 난이도 | 비고 |
|-----------|-----------|--------|------|
| `extracted/04_decoded/message.json` | **이미 가능 (kiwi 모드)** | Trivial | 현재 `repack --mode kiwi`가 binary로 동일 작업 수행. JSON 경유 시 byte 동일성은 미보장하나 의미적으로 동등. |
| `output/document.json` / `pages/*.json` | 가능하나 손실 있음 | Medium | 우리 export 시 raw 메시지의 일부 메타(blobs, derivedSymbolData 등)가 누락 → 재인코드 시 손실 발생. |
| `extracted/08_pen/*.pen.json` | 부분 가능 | Hard | 4-type Pencil 모델은 Figma 원본 메타(컴포넌트, 변수, 스타일, 인터랙션 등)를 보존하지 않음. 시각적 결과만 재현. |

---

## 1. 파이프라인 구조 (역방향)

```
.pen.json   ─[(C) 매우 어려움]─→  document.json/pages.json
                                      │
                                      │ [(B) 의미적 매핑 필요]
                                      ↓
                            extracted/04_decoded/message.json
                                      │
                                      │ [(A) kiwi 인코드 — 이미 구현]
                                      ↓
                              extracted/03_decompressed/data.kiwi.bin
                                      │
                                      │ [deflate-raw + fig-kiwi 아카이브]
                                      ↓
                              extracted/01_container/canvas.fig
                                      │
                                      │ [ZIP STORE 패키징 — 이미 구현]
                                      ↓
                                       .fig
```

`repack --mode kiwi`는 (A) 단계의 binary→binary roundtrip을 이미 수행한다.
정확히 같은 일을 JSON 경유로 하려면 **(A의 JSON 변형)만** 추가하면 된다.

## 2. 즉시 구현 가능한 경로: `repack --mode json`

**입력**: `extracted/04_decoded/message.json` (단, `--include-raw-message`로 추출 시에만 생성됨, ~150 MB)
**처리**:
1. `schema.json` 또는 `03_decompressed/schema.kiwi.bin`에서 kiwi 스키마 복원
2. `message.json` 파싱 + Uint8Array 필드 복원 (blobs[].bytes 등)
3. `kiwi.encodeMessage(schema, parsed)` → `data.kiwi.bin`
4. 이후 단계는 현재 kiwi 모드와 동일

**제약**:
- `Uint8Array`는 JSON.stringify 시 `{"0":1,"1":2,...}` object로 직렬화됨. 복원 시 명시적 변환 필요.
- 또는 추출 시 binary blob을 별도 디렉토리(`04_decoded/blobs/`)로 분리하고 message.json은 reference만 담는 방식이 깔끔함 (blobs가 큰 경우).

**수고**: 구현 ~80 LoC, test 포함 1-2시간.

## 3. 어려운 경로: `output/document.json` 편집 → .fig

`output/`은 사람이 읽기 쉬운 형태로 정제된 결과물이다. 현재 누락되는 것들:

1. **blobs**: 벡터 geometry, font metric, image hash 등의 binary blobs는 별도 디렉토리(assets/)로 분리됨.
2. **derivedSymbolData / derivedTextData**: Figma가 내부 캐시로 사용하는 layout/glyph 결과. raw에서 제외하지 않으면 round-trip 실패.
3. **componentPropRefs / componentPropAssignments**: 일부 보존되나 출력 시 단순화될 수 있음.
4. **internal sequence numbers**: kiwi 메시지의 순서/포지션 메타 일부.

**해결책**:
- 편집 시 `output/`이 아니라 `extracted/04_decoded/message.json`을 직접 편집하도록 가이드.
- 또는 raw → output 변환 시 손실 없는 `output/__raw_meta.json` sidecar를 함께 출력해 round-trip 시 복원.

## 4. 가장 어려운 경로: `.pen.json` → `.fig`

Pencil의 4-type 모델 (frame/text/path/rectangle)은 Figma의 풍부한 메타를 의도적으로 버린다:
- 컴포넌트(SYMBOL/INSTANCE) 관계 → frame으로 평탄화
- 컴포넌트 prop assignments / refs → 적용된 결과만 남김
- 변수(VARIABLE_SET / VARIABLE) → resolved 값만 남김
- 인터랙션(prototyping links) → 제거
- 스타일(공유 paint/text style) → inline됨

따라서 `.pen.json` 단독으로는 원본 .fig를 복구할 수 없다.

**현재 round-trip 보존 방식**:
- `editable-html --single-file`: HTML에 원본 .fig 바이트를 base64로 임베드
- `08_pen` + sidecar(`figma.editable.meta.js`): pen 편집 + 원본 메타 결합

`.pen.json` 편집 후 `.fig`로 돌아가려면:
1. **시각적 재현만 OK**: pen.json → 새로운 단순 .fig 생성 (모든 노드를 FRAME/TEXT/RECTANGLE/VECTOR로 매핑, 컴포넌트 없음).
2. **원본 보존 + diff 적용**: pen.json에 변경된 노드만 추출 → 원본 message.json에 patch 적용 → kiwi 인코드. 노드 매칭 (pen guid ↔ figma guid) 로직 필요.

## 5. 권장 로드맵

1. **즉시**: `repack --mode json` 구현 (`message.json` 입력) — 이미 90% 구현됨.
2. **단기**: `extract` 시 `04_decoded/message.json`을 default로 쓰되 blobs는 `04_decoded/blobs/`로 분리 (size 우려 해소).
3. **중기**: `output/document.json` 편집 → `.fig` 경로. raw 메타 sidecar 도입.
4. **장기 (선택)**: `.pen.json` diff → `message.json` patch → `.fig`. 노드 매칭 + override 합성 엔진 필요.

## 6. 구현 시 주의 사항

- **schema versioning**: 다른 .fig 파일에서 추출한 schema를 다른 message에 적용 X (각 파일은 자체 schema 보유).
- **kiwi 메시지 타입**: 보통 `MultiplayerMessage` 또는 `NodeChanges`. root type 보존 필요.
- **Uint8Array binary blobs**: JSON stringify로 손실 없는 표현이 필요. 권장: base64 encode (size +33% 약간) 또는 별도 binary 디렉토리.
- **archive version**: extracted/02_archive/_info.json의 version을 보존 (현재 v106).

## 7. 결론

**JSON→.fig는 binary→binary 경로(kiwi mode)와 동등한 일관성으로 구현 가능하나, "어떤 JSON"이냐가 핵심이다**:
- raw kiwi-decoded JSON: 거의 무료 (kiwi mode의 JSON 변형)
- 정제된 도큐먼트 JSON: 손실 보전을 위한 sidecar 메타가 필요함
- pen 단순 JSON: 컴포넌트/변수 관계 등이 손실되므로 원본 메타 결합이 필수
