# Upkeep — 설계 문서

- 상태: 출시됨. 본 스펙은 현재 동작을 기술합니다.
- 위치: 저장소 `wei18/upkeep`. 영어 base: `docs/en/design.md`, 각 언어 번역본: `docs/<locale>/design.md` (§6 참조)
- 자체 제약: **본 스펙은 SSOT이며, 구현에 맞춰 지속적으로 최신 상태를 유지해야 함** (이 도구 자체가 drift를 감지하는 도구이므로, 스펙이 drift되어서는 안 됨)

---

## 0. 목표

**재사용 가능한 GitHub Workflow(`on: workflow_call`)**로, 어떤 저장소든 자신의 workflow에서 job 수준의 `uses: wei18/upkeep/.github/workflows/audit.yml@v2`로 참조할 수 있습니다. 저장소 내 콘텐츠를 스캔하고 각자 전문 영역을 가진 subagent reviewer 집합을 파견하여, 데이터(코드 / 문서 / 스펙 / 시각 자료 / 아이콘 / 플로우 등)가 다음 기준을 충족하는지 검사합니다:

- up-to-date (실제 코드/최근 커밋과 drift가 없는지)
- 저장소 **자체** 규칙을 준수하는지
- 중복 파일이 없는지
- 사용되지 않는 (고아) 자료가 없는지

출력: HTML 심층 보고서 (artifact) + GitHub 추적 이슈 (요약 진입점).

핵심 원칙: **설정보다 관례(Convention over Configuration)**——저장소 현황에서 추론할 수 있는 것은 절대 수동으로 입력하지 않습니다. 오래된 설정 파일 자체가 drift의 원인이 되므로 반드시 피해야 합니다.

---

## 1. 아키텍처 및 실행 흐름

형태: **재사용 가능한 workflow** (`.github/workflows/audit.yml`, `on: workflow_call`), 내부적으로 공식 `claude-code-action`을 LLM 엔진으로 사용합니다. 호출 측에서 `CLAUDE_CODE_OAUTH_TOKEN` 시크릿을 제공해야 합니다 (`secrets: inherit` 또는 명시적 전달).
> composite action을 사용하지 않는 이유: composite action은 단일 job의 step 시퀀스이며, **`strategy.matrix`를 사용할 수 없습니다**. matrix(reviewer마다 하나의 병렬 job)는 workflow job 수준에서만 가능하므로 reusable workflow를 채택합니다 (GitHub 공식 문서에서 확인됨).

**편성 모델: fan-out → reduce (matrix + synthesis), LLM 리드 없음.** 활성화된 각 reviewer는 독립적인 matrix **job**을 실행합니다 (각 job에 `claude-code-action` step 하나 포함; `fail-fast: false` + `continue-on-error`로 장애 격리). 각자 구조화된 findings를 출력하고, 이후 단일 synthesis job (단일 LLM)이 모든 findings를 읽어 의미 수준의 cross-reviewer 연관 분석을 수행합니다. "단일 run 내 subagent 스폰"에 의존하지 않습니다 (해당 기능이 실증적으로 가능하더라도, per-job 방식이 결정론적 실행 / 격리 / 잔류 위험 제거 면에서 더 우수합니다).

트리거: reusable workflow는 `on: workflow_call`만 선언하므로 트리거는 호출 측 workflow가 결정합니다 — 보통 `schedule` (cron 정기 전체 스캔)과 `workflow_dispatch` (수동 실행)를 함께 사용합니다. 이 workflow에는 범위를 지정하는 input이 없으며, 실행은 항상 전체 스캔입니다.
> "중복 파일 / 고아 파일 / 전역 up-to-date" 검사는 전역적 시각이 필요하므로, PR 증분 방식으로는 처리할 수 없습니다. 따라서 전체 스캔을 기본으로 합니다.

단일 run 데이터 흐름:

```
Caller's trigger (schedule / workflow_dispatch)
  │
  ▼
[1] Discovery (deterministic, non-LLM heavy lifting)
    Scan repo → file inventory + modality classification (code/doc/spec/visual/flow/icon...)
    Read convention sources: CLAUDE.md, .claude/skills, .claude/workflows,
                .github/workflows, .claude/audit.yml (if present)
  │
  ▼
[2] Review (matrix: one claude-code-action step per enabled reviewer)
    GHA matrix gives native parallelism + fault isolation; the only concentrated LLM cost
    Each step carries: inventory + its file subset + composed rubric (built-in default ⊕ repo conventions)
    Each emits findings/<reviewer>.json (schema in §4)
  │
  ▼
[3] Synthesis (single claude-code-action, the only "connect-the-dots" brain)
    Reads all findings/*.json + inventory (compact structured material, no re-reading the whole repo)
    → semantic cross-reviewer correlation, dedup, systemic themes, prioritized narrative
    → synthesis.json
  │
  ▼
[4] Consolidate (deterministic)
    Mechanically merge findings + synthesis, dedup by key, sort (severity × confidence)
  │
  ▼
[5] Report (deterministic, zero LLM cost)
    ├─ Produce a self-contained single-file HTML report → upload artifact
    └─ Create/update tracking issue (markdown summary + link to HTML artifact)
```

요점:
- Discovery / Consolidate / Report는 **확정적 편성 골격**; Review와 Synthesis는 LLM.
- **LLM 리드 없음**: 편성 = GHA workflow (matrix) + Node. Review 단계의 각 reviewer는 완전히 독립적 (상호 통신 불필요); 교차 영역 종합 관점은 Synthesis라는 reduce step이 달성.
- findings는 통일된 스키마를 사용하여 Synthesis와 Consolidate 모두 기계적으로 처리 가능.

### 로컬 실행 (skill / 스크립트)

동일한 파이프라인을 `scripts/local-audit.sh <target>`로 로컬에서 실행할 수 있다: discovery → 병렬 `claude -p` 리뷰어 서브프로세스 → synthesis → report. 모든 중간 산출물(inventory, prompts, findings, synthesis)은 `mktemp` 작업 디렉터리에 두고 `--add-dir`로 Claude에 권한을 부여한다 — 대상 저장소에는 아무것도 쓰지 않는다. 로컬 실행도 동일한 self-contained HTML 리포트를 생성하며, GitHub 이슈를 upsert하는 대신 이슈 markdown을 터미널 요약으로 출력한다. `skills/upkeep-audit/SKILL.md`는 이 스크립트의 얇은 Claude Code 래퍼로, `~/.cache/upkeep` 클론을 유지하고 감사를 실행한 뒤 findings를 채팅으로 요약한다. 이 skill은 세 가지 방식으로 배포되며 모두 동일한 디렉터리를 가리킨다: Claude Code plugin으로(저장소 루트의 `.claude-plugin/marketplace.json`이 `skills/upkeep-audit/`을 `upkeep`이라는 이름의 single-skill plugin으로 등록하며 `/plugin install upkeep@upkeep`으로 설치), `npx skills add wei18/upkeep --skill upkeep-audit`을 통해(vercel-labs/skills 플랫 레이아웃), 또는 `~/.claude/skills/`에 수동 복사. 배포는 패키징일 뿐이며 — CI workflow는 여전히 직접적인 파이프라인 진입점으로, skill을 거치지 않는다.

### Marketplace Composite Action

세 번째 통합 경로는 동일한 엔진을 저장소 루트의 composite action(`action.yml`)으로 패키징하여, 익숙한 `- uses: wei18/upkeep@v2` step 문법과 [GitHub Marketplace](https://github.com/marketplace) 등재를 가능하게 한다. composite action은 `strategy.matrix`를 사용할 수 없는 단일 job이므로, `discovery` → `reviewer`(×7) → `synthesis` → `report` 각 step이 병렬이 아니라 순차적으로 실행된다 — 엔진과 입력은 동일하지만, 활성화된 리뷰어가 많은 저장소에서는 더 느려진다. 위 reusable workflow가 여전히 기본 경로인 이유는 `docs/ko/why-reusable-workflow.md`를 참조. 여기서의 배포 역시 skill과 마찬가지로 패키징일 뿐이다: `action.yml`은 reusable workflow가 사용하는 것과 동일한 `.github/actions/<x>@v2` 서브 action을 호출한다.

---

## 2. Reviewer 팀

내장 **7명** (6개 활성화, 1개 비활성화):

| Reviewer | 범위 | 주요 감지 문제 | 기본값 |
|---|---|---|---|
| `docs_staleness` | README, 문서, 주석, **다국어 README/doc 변형** | 콘텐츠 노후화, 코드와의 drift, 만료된 링크, **다국어 버전과 base 비동기화** | on |
| `code_hygiene` | 소스 코드 | 데드 코드, 미사용 파일/함수, 스펙 불일치, 명백한 코드 스멜 | on |
| `spec_flow` | 스펙, 플로우 차트, 상태 머신 | 플로우와 구현 불일치, 스펙 노후화 | on |
| `visual_icon` | 이미지, 아이콘, 디자인 시안 | 미사용 에셋, 중복 이미지, 크기/명명 규범 불일치 | on |
| `duplicate_orphan` | 전체 저장소 | 중복 파일, 고아 파일, 미참조 리소스 | on |
| `convention` | 전체 저장소 | 저장소 자체 skills/workflows/CLAUDE.md 규범 위반 | on |
| `i18n` | 로컬라이제이션 문자열, `.lproj` 등 | 번역 누락, 미사용 키, base와 비동기화 | **off** |

동적 커스텀 reviewer는 지원하지 않습니다 (§11). 내장 `i18n` reviewer(기본 비활성화)가 일반적인 요구사항을 충족합니다.

### Rubric 3단계 합성 (우선순위 낮은 것부터 높은 순)

```
Built-in default rubric (shipped with the action; defines what this specialty looks for)
   ⊕ repo-convention auto-discovery (the domain-relevant parts of
                         CLAUDE.md / .claude/skills / .claude/workflows)
   ⊕ audit.yml explicit override (the repo file pointed to by reviewers.<name>.rubric) ← highest priority
```

저장소에 자체 기준이 있을 경우 저장소 기준을 우선 적용합니다. `convention`은 거의 전적으로 저장소 자체 규범에 의존하며, `visual_icon`은 내장 기본값 + 저장소 디자인 규범 (있을 경우)에 주로 의존합니다.

**Reviewer rubric 언어(`rubric_lang`)**: 내장 rubric은 로케일별로 `reviewers/<locale>/`에 배치되며, `en`과 `zh-TW` 두 세트가 있습니다. `rubric_lang` workflow input(기본값 `en`)이 reviewer와 synthesis가 사용할 세트를 선택합니다. 그 밖의 값을 지정하면 해당 prompt 파일이 없으므로 모든 reviewer와 synthesis step이 실패합니다.

### 2.1 다국어 문서 동기화 감지 (multilingual doc-set)

`docs_staleness`가 담당합니다 (`i18n`이 아님——`i18n`은 `.lproj`/`Localizable.strings`와 같은 코드 수준 로컬라이제이션 문자열을 관리하며, 문서 번역 drift는 doc 영역에 해당합니다).

- **디렉터리 관례**: 다국어 문서는 `docs/<locale>/<name>.md`에 위치합니다 (예: `docs/zh-TW/overview.md`). 유일한 예외는 저장소 루트의 `README.md` = **영어 base** (GitHub 관례)이며, 각 언어 번역본은 `docs/<locale>/README.md`에 위치합니다.
- **base 언어**: `en` (루트 `README.md`와 `docs/en/*`이 권위 있는 소스).
- **지원 언어 (최대 6개)**: `en`(base), `zh-TW`, `zh-CN`, `ja`, `ko` (6번째 예약).
- **감지**: base (`docs/en/<name>.md`, README의 경우 루트 `README.md`)를 기준으로 각 `docs/<locale>/<name>.md`에 대해 "뒤처짐/누락/노후화"를 보고합니다. §3 원칙을 따릅니다——증거 첨부 (git 최근성: base가 변경되었지만 특정 언어 번역본이 갱신되지 않은 경우), "번역이 반드시 업데이트해야 하는 쪽"이라고 단정하지 않습니다. 단, base가 더 최신인 경우 일반적으로 번역이 뒤처진 것으로 판단하는 경향이 있습니다.
- **그룹화**: reviewer는 "동일 파일명이 `docs/<locale>/` 하위 디렉터리에 걸쳐 존재하는" 방식으로 그룹화합니다 (README는 루트 `README.md`와 `docs/<locale>/README.md`를 동일 그룹으로 처리).
- **Dogfood**: 본 저장소 자체의 모든 사용자 문서 (README, overview, design, why-reusable-workflow)를 `docs/<locale>/`에 다국어화하여, 동시에 이 기능의 실제 테스트 샘플로 활용합니다 (§10 참조).

---

## 3. SSOT 처리 원칙 (진실의 원천을 미리 단정하지 않음)

문제점: 스펙/코드가 반드시 SSOT인 것은 아닙니다. **오히려 스펙 자체가 노후화된 경우도 있습니다.** 방향을 고정으로 단정하면 오탐이 발생합니다.

원칙: **reviewer는 SSOT를 단정하지 않고 "불일치"만 감지하며, 방향 판단은 증거와 분급 재결에 맡깁니다.**

1. **불일치 감지, 단정 금지**: "A는 X라고 하고, B는 Y라고 하여 불일치"를 보고하며, "B가 노후화되었다"고 단정하지 않습니다.
2. **증거 신호 첨부**: git 최종 수정 시간 / 커밋 최근성, 참조 횟수, 참조 방향.
3. **분급 재결**:
   - 증거가 강한 경우 (예: 어떤 파일이 6개월간 수정되지 않았고 관련 코드가 지난주 크게 변경된 경우) → `ssot_direction`을 `stale_a` 또는 `stale_b`로 설정하고(§4) 제안에 방향을 명시합니다("README가 더 오래되었으므로 업데이트 권장"). 그래도 사람의 확인이 필요합니다.
   - 증거가 약한 경우 → `ssot_direction`을 `uncertain`으로 설정하고, 방향은 사람이 판단해야 한다고 제안에 적습니다.
   - **어떤 경우에도 자동 수정하지 않습니다** (자동 수정은 범위 밖입니다, §11 참조).
4. **SSOT는 선언 파일에 의존하지 않음**: 방향은 전적으로 추론에 의존하며, 선언 파일 자체가 노후화되는 상황을 방지합니다. 고정된 정책이 있는 저장소는 재정의용 rubric(`reviewers.<name>.rubric`, §5)에 그 정책을 적을 수 있습니다 (선택 사항이며 권장하지 않음).

---

## 4. findings 스키마

각 reviewer는 `findings/<reviewer>.json` 파일 하나를 작성하며, 문제마다 레코드 하나를 기록합니다:

```json
{
  "reviewer": "docs_staleness",
  "status": "ok",
  "findings": [
    {
      "file": "path/to/file",
      "related": ["path/to/other-file"],
      "reviewer": "docs_staleness",
      "category": "staleness",
      "problem": "...",
      "evidence": "...",
      "suggestion": "...",
      "severity": "medium",
      "confidence": "high",
      "ssot_direction": "stale_a"
    }
  ]
}
```

- `status`: `ok` 또는 `failed`. 실패한 reviewer는 `status: "failed"`와 `findings: []`를 작성하며, 다른 reviewer에는 영향이 없습니다.
- `file`: 주 파일. 여러 파일에 걸친 문제는 주 파일에 기록하고 나머지는 `related`에 나열합니다.
- `related`: 관련된 다른 파일. 비어 있어도 됩니다. 비교 대상인 반대쪽 파일을 맨 앞에 둡니다. 이 순서는 `findings/<reviewer>.json` 안에서만 의미가 있습니다: Consolidate가 `related`를 병합하고 다시 정렬하므로, 통합된 보고서에서는 이 순서가 유지되지 않습니다.
- `category`: `staleness`, `duplicate`, `orphan`, `convention`, `inconsistency`, `i18n_sync`, `other` 중 하나.
- `problem`: 사람이 읽을 수 있는 문제 설명.
- `evidence`: 뒷받침하는 증거 (git 시간, 참조 관계, 구체적인 불일치 지점).
- `suggestion`: 수정 제안. 분급 재결에 따라 방향을 제시할 수 있습니다 (§3).
- `severity`, `confidence`: 각각 `low`, `medium`, `high` 중 하나.
- `ssot_direction`: 다음 네 값 중 하나.
  - `stale_a`: `file`이 오래된 쪽입니다.
  - `stale_b`: `related`의 첫 번째 파일이 오래된 쪽입니다.
  - `uncertain`: 양쪽이 불일치하지만 어느 쪽이 오래되었는지 증거로 판단할 수 없습니다.
  - `n/a`: 비교할 양쪽이 없는 문제입니다.

`category`, `severity`, `confidence` 각 값의 판단 기준은 한 곳, reviewer prompt(`reviewers/<locale>/_reviewer-prompt.md`)에서만 정의합니다. `src/findings.ts`가 각 파일을 허용 값에 맞춰 검증하며, 검증에 실패한 파일은 `failed` 결과로 대체됩니다.

**Consolidate 중복 제거/정렬 (확정적)**: `file` + `category`를 키로 cross-reviewer 중복을 병합합니다——동일 키에서 "대표 finding" = severity×confidence 최고값 선택 (동점일 경우 reviewer 열거 순서를 안정적인 타이브레이크로 사용), `reviewers[]`는 해당 키를 보고한 모든 reviewer의 합집합, `related[]`는 합집합으로 수집합니다. 정렬 키 = severity 내림차순 → confidence 내림차순 → file 오름차순.

### 4.1 synthesis 출력

Synthesis step은 모든 `findings/*.json` + inventory를 읽어 `synthesis.json`을 출력합니다. **findings는 파일 경로로 참조합니다 (정수 인덱스 사용 안 함——LLM에게 더 안정적이고 사람이 읽기 쉬움)**:

```json
{
  "themes": [
    {
      "title": "...",
      "narrative": "...",
      "related_files": ["path/a", "path/b"],
      "priority": "high"
    }
  ],
  "semantic_duplicates": [["reviewer|file|category", "reviewer|file|category"]],
  "executive_summary": "...",
  "status": "ok"
}
```

- `themes`: reviewer를 가로지르는 시스템적 주제. `title`은 시스템적 문제의 요약, `narrative`는 해당 finding들이 동일한 근본 원인을 가리키는 이유, `related_files`는 주제가 다루는 파일 경로, `priority`는 `low`, `medium`, `high` 중 하나입니다.
- `semantic_duplicates`: 같은 문제를 가리키는 finding 키 그룹. 각 키의 형식은 `reviewer|file|category`입니다. Consolidate가 각 그룹을 finding 하나로 병합합니다.
- `executive_summary`: 전체 건강 상태를 한 단락으로 요약한 내용.
- `status`: `ok` 또는 `failed`. synthesis가 실패하면 `themes: []`를 작성합니다.

Report는 raw findings와 synthesis를 함께 사용합니다. synthesis 실패 또는 미존재 시 raw findings만 표시로 강등됩니다 (themes/executive summary 없음).

---

## 5. 설정 파일 `.claude/audit.yml` (전부 선택적, 없어도 완전히 동작함)

`scan`과 `ssot`는 **설정에 포함하지 않습니다** (자체적으로 노후화될 수 있음). 대신 자동 추론을 사용합니다.

```yaml
# .claude/audit.yml
version: 1
ignore:
  - "docs/*/plans/**"
reviewers:
  visual_icon: { enabled: false }
  i18n:        { enabled: true }
  docs_staleness:
    paths: ["README.md", "docs/**"]
    rubric: "docs/audit-rubric.md"
report:
  min_severity: "low"
```

모든 키는 선택 사항입니다:

- `version`: 설정 스키마 버전. 현재는 `1`입니다.
- `ignore`: glob 경로. 일치하는 파일은 inventory에서 제외되어 어떤 reviewer에게도 보이지 않습니다. 기본값: 없음.
- `reviewers.<name>.enabled`: reviewer를 켜거나 끕니다. 기본값: `i18n`을 제외하고 모두 활성화. 나열하지 않은 reviewer는 기본값을 유지하며, 알 수 없는 이름은 무시됩니다.
- `reviewers.<name>.paths`: glob 경로. 설정하면 해당 reviewer의 target 파일은 파일 유형에 따른 기본 선택(§2 표의 「범위」 열) 대신 inventory에서 일치하는 파일이 됩니다.
- `reviewers.<name>.rubric`: rubric 파일의 저장소 루트 기준 상대 경로. reviewer는 이를 최우선 rubric 계층으로 읽습니다 (§2).
- `report.min_severity`: `low`, `medium`, `high` 중 하나. 이 값보다 낮은 finding은 tracking issue에 들어가지 않으며, HTML 보고서에는 모든 finding이 남습니다. 기본값: `low`. camelCase 표기인 `minSeverity`도 허용합니다.

Glob 문법: `*`는 경로 세그먼트 하나 안에서 일치하고, `**`는 세그먼트를 넘어 일치하며, `?`는 문자 하나와 일치합니다.

issue 라벨은 설정 키가 아닙니다. `issue_label` workflow input(기본값 `audit`)으로 지정합니다.

### 자동 추론 (설정 불필요)

- **스캔 범위**: `git ls-files --cached --others --exclude-standard`가 나열하는 모든 파일(추적 중인 파일과 추적되지 않은 파일, `.gitignore` 준수)에서 `ignore` glob에 일치하는 파일을 제외한 것입니다. lockfile의 파일 카테고리는 `other`이므로 저장소 전체를 보는 reviewer(`duplicate_orphan`, `convention`)만 받습니다. 100KB를 넘는 텍스트 파일은 플래그만 붙고 건너뛰지 않습니다 (§7).
- **SSOT 방향**: 전적으로 증거 기반 추론 (§3), 선언 파일 없음.

---

## 6. 저장소 위치 (확정)

Upkeep은 `uses:`로 참조되므로 독립 저장소 `wei18/upkeep`에 둡니다 (`uses: wei18/upkeep@v2`).

구조:

```
upkeep/
├── action.yml                        # composite action (Marketplace listing): `uses: wei18/upkeep@v2`, sequential reviewer steps
├── .github/
│   ├── workflows/audit.yml          # reusable workflow (on: workflow_call): jobs/matrix orchestration
│   └── actions/                     # composite sub-actions (used by the workflow's jobs; carry Upkeep's own code)
│       ├── discovery/  reviewer/  synthesis/  report/
├── .claude-plugin/marketplace.json  # plugin marketplace catalog (plugin name: upkeep, source: ./skills/upkeep-audit)
├── README.md                        # English base usage (job-level uses: example, secret/permissions) + language switcher
├── docs/
│   ├── en/      overview.md  design.md  why-reusable-workflow.md   (no README: the root README.md is the en base)
│   ├── zh-TW/   README.md  overview.md  design.md  why-reusable-workflow.md
│   ├── zh-CN/ … ja/ … ko/   (same set as zh-TW)
│   ├── archive/plans/               # original implementation plans: historical record, not localized
│   └── superpowers/                 # design-process specs and plans: historical record, not localized
├── reviewers/<locale>/              # 7 built-in rubrics + _reviewer-prompt + _synthesis-prompt, per locale (en, zh-TW); picked by rubric_lang
├── skills/upkeep-audit/             # Claude Code skill: thin local-run wrapper (clones to ~/.cache/upkeep)
│   └── .claude-plugin/plugin.json   # plugin manifest (single-skill layout; SKILL.md at plugin root)
├── scripts/local-audit.sh           # local pipeline orchestrator (same flow as CI; temp-dir intermediates)
├── src/                             # deterministic TS: discovery/consolidate/report/matrix/prompt-bundle, etc.
└── test/                            # unit + contract tests (§10)
```

> 아카이브 참고: `docs/archive/plans/`와 `docs/superpowers/`는 Upkeep을 구축한 과정의 이력 기록입니다. 다국어화하지 않고, 어떤 내비게이션 인덱스에서도 링크되지 않으며, 현행 규칙도 아닙니다 — 현행 규칙은 본 스펙입니다. `.claude/audit.yml`은 이 두 `plans/` 디렉터리를 자체 감사에서 제외합니다.

> 서브 action 메커니즘: reusable workflow의 job은 **호출 측** checkout에서 실행됩니다. Upkeep 자체 코드(src/, reviewers/)는 `uses: wei18/upkeep/.github/actions/<x>@v2`을 통해 주입됩니다 (GitHub이 자동으로 Upkeep 저장소를 가져옴). 각 reviewer는 독립적인 matrix job으로 plain `claude-code-action` 프롬프트를 실행하여 `findings/<reviewer>.json`을 작성하며, **in-run subagent가 불필요**하므로 `--agents`/`Agent` passthrough 위험이 사라집니다.

---

## 7. 모달 분류

Discovery는 모든 파일에 `modality` 하나를 지정합니다. 100KB 상한선은 reviewer가 텍스트로 읽는 파일에만 적용하며, 이미지에는 적용하지 않습니다.

| `modality` | 대상 | reviewer의 처리 방식 |
|---|---|---|
| `raster_image` | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, `.tiff`, `.heic`, `.ico`, `.icns` | 바이트 상한선 없음. 메타데이터로 판단하며, 아래의 유일한 경우에만 이미지로 엽니다 |
| `vector_diagram` | `.svg`, `.mmd`, `.dot`, `.puml`, `.plantuml` | **원시 코드 텍스트**로 읽기 (의미 diff 가능). 100KB를 넘으면 inventory가 `oversizedText: true`를 설정합니다 |
| `binary` | 처음 8000바이트 안에 NUL 바이트가 있는 그 밖의 파일 | 메타데이터(`hash`, `sizeBytes`, `referencedBy`)로만 판단합니다 |
| `text` | 나머지 모든 파일 | 텍스트로 읽기. 100KB를 넘으면 inventory가 `oversizedText: true`를 설정합니다 |

`oversizedText`는 inventory의 플래그일 뿐입니다: 크기 때문에 파일이 잘리거나, 분할되거나, 요약되거나, 버려지는 일은 없습니다. reviewer prompt는 플래그가 붙은 파일을 나누어 읽도록 reviewer에게 지시합니다.

visual reviewer의 대부분 작업은 이미지를 "보는" 것이 불필요합니다:
- 중복 이미지 → 파일 해시 (완전 일치)
- 고아 이미지 → 참조 관계 그래프
- 명명/크기 규범 → 메타데이터
- **"이미지 내용이 디자인/스펙을 충족하는지"만 이미지를 열어야 합니다**. rubric은 이를 의심스러운 소수의 에셋으로 제한합니다

---

## 8. 복원력 / 강등 처리

| 실패 시나리오 | 처리 방법 |
|---|---|
| 특정 reviewer가 중단되거나, 타임아웃되거나, 유효하지 않은 출력을 작성함 | 해당 reviewer의 결과가 `status:"failed"`, `findings:[]`가 됨 (matrix `fail-fast: false`); 나머지 reviewer는 정상 진행; 보고서와 이슈가 "불완전한 실행" 경고로 실패한 reviewer를 명시 |
| Synthesis step 실패 | 강등: Report가 raw findings만 표시（교차 영역 주제/서술 없음）, 전체 run을 실패로 만들지 않음 |
| 모든 reviewer 실패 | run은 그대로 완료됨: 보고서와 이슈가 finding 없이 생성되고, "불완전한 실행" 경고가 모든 reviewer를 나열 |
| Discovery 스캔 결과 파일 0개 | 정상 종료, 오류 아님 |

원칙: Review/Synthesis 단계의 서브 실패는 모두 격리 강등 처리; 확정적 골격(Discovery/Consolidate/Report) 실패 시에만 전체 run을 실패로 처리합니다.

---

## 9. 비용 제어

- reviewer가 받는 것은 inventory(메타데이터)와 target 파일 목록이며, 파일 내용이 아닙니다. prompt는 메타데이터로 의심스러운 파일을 추린 뒤 그 파일만 심층 독해하도록 지시합니다
- `max_turns`(기본값 30)가 각 reviewer 호출과 synthesis 호출의 turn 수를 제한합니다
- `.gitignore` 또는 `ignore`로 제외된 파일은 inventory에 들어가지 않습니다 (§5)
- HTML / 이슈 조립은 순수 텍스트 처리로 **LLM 비용 없음**

---

## 10. 테스트 전략

테스트 샘플: 원격 실제 저장소 **https://github.com/wei18/Sudoku** (자체 fixture 대체).

- **확정적 계층 → 단위 테스트 (TDD)**: Discovery 분류, Consolidate 중복 제거 정렬, HTML/이슈 조립. LLM 미사용.
- **LLM 계층 → 계약 테스트**: subagent 출력이 **findings 스키마를 충족하는지** 검증 (필드 완전성, severity/confidence/ssot_direction이 유효한 값 범위 내에 있는지). 내용의 자구 단언은 하지 않음.
  - CI: **녹화된 가짜 response**를 사용하여 스키마 계약 테스트 (비용 절감, 안정성).
  - 실제 API 호출: 수동 / 릴리스 전 smoke 테스트만.
- **엔드-투-엔드 smoke (수동, CI에 포함되지 않음)**: Sudoku 저장소에서 전체 workflow를 실행하고, HTML artifact와 이슈의 존재 여부, findings의 스키마 준수 여부, 합리적인 수의 문제 감지 여부를 확인 (자구 단언 불필요).
- **Dogfood**: `.github/workflows/self-audit.yml`이 본 저장소에 대해 매주 감사를 실행합니다.

---

## 11. 범위 경계 (범위 밖)

- 자동 수정 PR (README 자동 수정/고아 파일 삭제) ——계획 없음. Upkeep은 출력만 합니다
- 동적 커스텀 reviewer——reviewer 구성은 고정입니다. 내장 reviewer는 `reviewers.<name>.paths`와 `reviewers.<name>.rubric`(§5)으로 조정합니다
- PR 증분 모드——실행은 항상 전체 스캔입니다
- SSOT 선언 파일——방향은 증거에서 추론합니다
