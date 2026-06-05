# Upkeep — 설계 문서

- 상태: 설계 확정, 구현 계획 작성 예정
- 날짜: 2026-06-04
- 위치: 독립 저장소 `upkeep/`, 스펙은 `docs/design.md`에 위치 (§6 참조)
- 자체 제약: **본 스펙은 SSOT이며, 구현에 맞춰 지속적으로 최신 상태를 유지해야 함** (이 도구 자체가 drift를 감지하는 도구이므로, 스펙이 drift되어서는 안 됨)

---

## 0. 목표

**재사용 가능한 GitHub Workflow(`on: workflow_call`)**로, 어떤 저장소든 자신의 workflow에서 job 수준의 `uses: wei18/upkeep/.github/workflows/audit.yml@v1`로 참조할 수 있습니다. 저장소 내 콘텐츠를 스캔하고 각자 전문 영역을 가진 subagent reviewer 집합을 파견하여, 데이터(코드 / 문서 / 스펙 / 시각 자료 / 아이콘 / 플로우 등)가 다음 기준을 충족하는지 검사합니다:

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

트리거: `schedule` (cron 정기 전체 스캔) + `workflow_dispatch` (수동, 범위 파라미터 지정 가능).
> "중복 파일 / 고아 파일 / 전역 up-to-date" 검사는 전역적 시각이 필요하므로, PR 증분 방식으로는 처리할 수 없습니다. 따라서 전체 스캔을 기본으로 합니다.

단일 run 데이터 흐름:

```
트리거 (schedule / workflow_dispatch)
  │
  ▼
[1] Discovery（확정적, LLM 불필요한 작업）
    repo 스캔 → 파일 목록 + 모달 분류(code/doc/spec/visual/flow/icon...)
    규범 소스 읽기: CLAUDE.md、.claude/skills、.claude/workflows、
                .github/workflows、.claude/audit.yml(존재 시)
  │
  ▼
[2] Review（matrix: 활성화된 reviewer마다 claude-code-action step 하나）
    GHA matrix 기본 병렬 실행, 장애 격리; 유일한 LLM 비용 집중 지점
    각 step 전달: inventory + 담당 파일 서브셋 + 합성 rubric(내장 기본값 ⊕ repo 규범)
    각자 findings/<reviewer>.json 출력 (스키마: §4 참조)
  │
  ▼
[3] Synthesis（단일 claude-code-action, 유일한 "종합 판단" 두뇌）
    모든 findings/*.json + inventory 읽기（간결한 구조화 자료, repo 전체 재독 불필요）
    → 의미 수준 cross-reviewer 연관, 중복 제거, 시스템적 주제, 우선순위 서술
    → synthesis.json
  │
  ▼
[4] Consolidate（확정적）
    findings + synthesis 기계적 병합、키 중복 제거、정렬(severity × confidence)
  │
  ▼
[5] Report（확정적, LLM 비용 없음）
    ├─ self-contained 단일 HTML 보고서 생성 → artifact 업로드
    └─ 추적 이슈 생성/업데이트 (markdown 요약 + HTML artifact 링크)
```

요점:
- Discovery / Consolidate / Report는 **확정적 편성 골격**; Review와 Synthesis는 LLM.
- **LLM 리드 없음**: 편성 = GHA workflow (matrix) + Node. Review 단계의 각 reviewer는 완전히 독립적 (상호 통신 불필요); 교차 영역 종합 관점은 Synthesis라는 reduce step이 달성.
- findings는 통일된 스키마를 사용하여 Synthesis와 Consolidate 모두 기계적으로 처리 가능.

---

## 2. Reviewer 팀

내장 **7명** (6개 활성화, 1개 비활성화):

| Reviewer | 범위 | 주요 감지 문제 | 기본값 |
|---|---|---|---|
| `docs_staleness` | README, 문서, 주석, **다국어 README/doc 변형** | 콘텐츠 노후화, 코드와의 drift, 만료된 링크, **다국어 버전과 base 비동기화** | on |
| `code_hygiene` | 소스 코드 | 데드 코드, 미사용 파일/함수, 스펙 불일치 | on |
| `spec_flow` | 스펙, 플로우 차트, 상태 머신 | 플로우와 구현 불일치, 스펙 노후화 | on |
| `visual_icon` | 이미지, 아이콘, 디자인 시안 | 미사용 에셋, 중복 이미지, 크기/명명 규범 불일치 | on |
| `duplicate_orphan` | 전체 저장소 | 중복 파일, 고아 파일, 미참조 리소스 | on |
| `convention` | 전체 저장소 | 저장소 자체 skills/workflows/CLAUDE.md 규범 위반 | on |
| `i18n` | 로컬라이제이션 문자열, `.lproj` 등 | 번역 누락, 미사용 키, base와 비동기화 | **off** |

첫 번째 버전에서는 **동적 커스텀 reviewer를 지원하지 않습니다**. i18n은 내장 (기본 비활성화)으로 구현하여 일반적인 요구사항을 충족합니다 (YAGNI).

### Rubric 3단계 합성 (우선순위 낮은 것부터 높은 순)

```
내장 기본 rubric（action 자체 제공, 해당 전문 영역에서 감지할 내용 정의）
   ⊕ repo 규범 자동 탐색（CLAUDE.md / .claude/skills / .claude/workflows
                         에서 해당 영역과 관련된 항목）
   ⊕ audit.yml 명시적 지정（reviewers.<name>.rubric이 가리키는 repo 파일）← 최고 우선순위
```

저장소에 자체 기준이 있을 경우 저장소 기준을 우선 적용합니다. `convention`은 거의 전적으로 저장소 자체 규범에 의존하며, `visual_icon`은 내장 기본값 + 저장소 디자인 규범 (있을 경우)에 주로 의존합니다.

### 2.1 다국어 문서 동기화 감지 (multilingual doc-set)

`docs_staleness`가 담당합니다 (`i18n`이 아님——`i18n`은 `.lproj`/`Localizable.strings`와 같은 코드 수준 로컬라이제이션 문자열을 관리하며, 문서 번역 drift는 doc 영역에 해당합니다).

- **디렉터리 관례**: 다국어 문서는 `docs/<locale>/<name>.md`에 위치합니다 (예: `docs/zh-TW/overview.md`). 유일한 예외는 저장소 루트의 `README.md` = **영어 base** (GitHub 관례)이며, 각 언어 번역본은 `docs/<locale>/README.md`에 위치합니다.
- **base 언어**: `en` (루트 `README.md`와 `docs/en/*`이 권위 있는 소스).
- **지원 언어 (최대 6개)**: `en`(base), `zh-TW`, `zh-CN`, `ja`, `ko` (6번째 예약).
- **감지**: base (`docs/en/<name>.md`, README의 경우 루트 `README.md`)를 기준으로 각 `docs/<locale>/<name>.md`에 대해 "뒤처짐/누락/노후화"를 보고합니다. §3 원칙을 따릅니다——증거 첨부 (git 최근성: base가 변경되었지만 특정 언어 번역본이 갱신되지 않은 경우), "번역이 반드시 업데이트해야 하는 쪽"이라고 단정하지 않습니다. 단, base가 더 최신인 경우 일반적으로 번역이 뒤처진 것으로 판단하는 경향이 있습니다.
- **그룹화**: reviewer는 "동일 파일명이 `docs/<locale>/` 하위 디렉터리에 걸쳐 존재하는" 방식으로 그룹화합니다 (README는 루트 `README.md`와 `docs/<locale>/README.md`를 동일 그룹으로 처리).
- **Dogfood**: 본 저장소 자체의 모든 사용자 문서 (README, overview, design, plans)를 `docs/<locale>/`에 다국어화하여, 동시에 이 기능의 실제 테스트 샘플로 활용합니다 (§10 참조).

---

## 3. SSOT 처리 원칙 (진실의 원천을 미리 단정하지 않음)

문제점: 스펙/코드가 반드시 SSOT인 것은 아닙니다. **오히려 스펙 자체가 노후화된 경우도 있습니다.** 방향을 고정으로 단정하면 오탐이 발생합니다.

원칙: **reviewer는 SSOT를 단정하지 않고 "불일치"만 감지하며, 방향 판단은 증거와 분급 재결에 맡깁니다.**

1. **불일치 감지, 단정 금지**: "A는 X라고 하고, B는 Y라고 하여 불일치"를 보고하며, "B가 노후화되었다"고 단정하지 않습니다.
2. **증거 신호 첨부**: git 최종 수정 시간 / 커밋 최근성, 참조 횟수, 참조 방향.
3. **분급 재결**:
   - 증거가 강한 경우 (예: 어떤 파일이 6개월간 수정되지 않았고 관련 코드가 지난주 크게 변경된 경우) → 제안에 방향을 명시("README가 더 오래되었으므로 업데이트 권장"), 그래도 `needs-confirmation`으로 표시.
   - 증거가 약한 경우 → "drift, 방향 재결 필요"로 표시.
   - **어떤 경우에도 자동 수정하지 않습니다** (자동 수정은 2단계에서 검토).
4. **SSOT는 선언 파일에 의존하지 않음**: 방향은 전적으로 추론에 의존하며, 선언 파일 자체가 노후화되는 상황을 방지합니다. 고정된 정책이 있는 저장소만 escape hatch 재정의를 사용합니다 (불필요하며 권장하지 않음).

---

## 4. findings 스키마

각 reviewer는 각 문제에 대해 다음을 출력합니다:

```jsonc
{
  "file": "path/to/file",          // 주체 파일（교차 파일 문제는 주 파일에 기재, related로 보충）
  "related": ["path/..."],          // 관련 파일（비어 있어도 됨）
  "reviewer": "docs_staleness",
  "category": "staleness | duplicate | orphan | convention | inconsistency | ...",
  "problem": "사람이 읽을 수 있는 문제 설명",
  "evidence": "뒷받침 증거（git 시간, 참조 관계, 구체적인 불일치 사항）",
  "suggestion": "권장 수정 방법（분급 재결에 따라 방향 포함 가능）",
  "severity": "high | medium | low",
  "confidence": "high | medium | low",
  "ssot_direction": "stale_a | stale_b | uncertain | n/a",
  "status": "ok"                    // reviewer 수준: ok | failed
}
```

각 reviewer step은 `findings/<reviewer>.json` 하나를 출력합니다: `{ reviewer, status: "ok"|"failed", findings: Finding[] }` (단일 reviewer 실패 시 `status:"failed"`, `findings:[]`이며 다른 reviewer에는 영향 없음).

**Consolidate 중복 제거/정렬 (확정적)**: `file` + `category`를 키로 cross-reviewer 중복을 병합합니다——동일 키에서 "대표 finding" = severity×confidence 최고값 선택 (동점일 경우 reviewer 열거 순서를 안정적인 타이브레이크로 사용), `reviewers[]`는 해당 키를 보고한 모든 reviewer의 합집합, `related[]`는 합집합으로 수집합니다. 정렬 키 = severity 내림차순 → confidence 내림차순 → file 오름차순.

### 4.1 synthesis 출력

Synthesis step은 모든 `findings/*.json` + inventory를 읽어 `synthesis.json`을 출력합니다. **findings는 파일 경로로 참조합니다 (정수 인덱스 사용 안 함——LLM에게 더 안정적이고 사람이 읽기 쉬움)**:

```jsonc
{
  "themes": [                         // cross-reviewer 시스템적 주제
    {
      "title": "시스템적 문제 간략 설명",
      "narrative": "이 findings들이 동일한 근본 원인을 가리키는 이유",
      "related_files": ["path/a", "path/b"],  // 이 주제에 포함된 파일 경로
      "priority": "high | medium | low"
    }
  ],
  "semantic_duplicates": [[ "reviewer|file|category", "reviewer|file|category" ]], // 의미상 중복인 finding 키 그룹
  "executive_summary": "전체 건강 상태에 대한 한 단락 요약",
  "status": "ok"                      // synthesis 실패 → report는 raw findings만 출력
}
```

Report는 raw findings와 synthesis를 함께 사용합니다. synthesis 실패 또는 미존재 시 raw findings만 표시로 강등됩니다 (themes/executive summary 없음).

---

## 5. 설정 파일 `.claude/audit.yml` (전부 선택적, 없어도 완전히 동작함)

`scan`과 `ssot`는 **설정에 포함하지 않습니다** (자체적으로 노후화될 수 있음). 대신 자동 추론을 사용합니다.

```yaml
# .claude/audit.yml —— 전부 선택적; 일반적으로 이 파일이 필요하지 않음
version: 1
reviewers:               # "비활성화/범위 조정/i18n 활성화"할 항목만 나열, 나머지는 기본값 유지
  visual_icon: { enabled: false }
  i18n:        { enabled: true }
report:
  issue_label: "audit"   # 기본값이 "audit"이므로 변경 시에만 작성
  min_severity: "low"    # 이 수준 미만은 이슈에 포함되지 않음（HTML 전체 보고서에는 포함）
```

### 자동 추론 (설정 불필요)

- **스캔 범위**: 저장소 `.gitignore` 준수; binary / lockfile / 빌드 산출물 자동 건너뜀; 텍스트 파일 내장 100KB 상한선 적용 (§7 모달 분류 참조).
- **SSOT 방향**: 전적으로 증거 기반 추론 (§3), 선언 파일 없음.

---

## 6. 저장소 위치 (확정)

이 action은 `uses:`로 참조 가능하도록 발행되므로 독립 저장소로 분리합니다. 로컬 디렉터리 `/Users/zw/GitHub/Wei18/repo-audit-action/` (이미 `git init`됨); **발행/패키지명은 `Upkeep`** (`uses: wei18/upkeep@v1`)——로컬 폴더명과 발행명이 다른 것은 의도적으로 유지합니다.

예상 구조:

```
repo-audit-action/                   # 로컬 디렉터리（발행명 Upkeep）
├── .github/
│   ├── workflows/audit.yml          # 재사용 가능한 workflow（on: workflow_call）: jobs/matrix 편성
│   └── actions/                     # composite 서브 action（workflow의 job uses에서 참조, Upkeep 코드 포함）
│       ├── discovery/  reviewer/  synthesis/  report/
├── README.md                        # 영어 base 사용법（job-level uses: 예시, secret/권한）+ 언어 전환 목록
├── docs/
│   ├── en/      README 없음（루트가 en); overview.md  design.md  why-reusable-workflow.md  plans/
│   ├── zh-TW/   README.md  overview.md  design.md  plans/
│   ├── zh-CN/ … ja/ … ko/   （각 언어별 동일 구성）
│   └── （다국어 사용자 문서는 모두 docs/<locale>/; 루트 README.md는 en base）
├── reviewers/                       # 7개 내장 reviewer rubric + _reviewer-prompt + _synthesis-prompt
├── src/                             # discovery/consolidate/report/matrix/prompt-bundle 등 확정적 TS
└── test/                            # 단위 + 계약 + e2e（테스트 샘플: §10 참조）
```

> 서브 action 메커니즘: reusable workflow의 job은 **호출 측** checkout에서 실행됩니다. Upkeep 자체 코드(src/, reviewers/)는 `uses: wei18/upkeep/.github/actions/<x>@v1`을 통해 주입됩니다 (GitHub이 자동으로 Upkeep 저장소를 가져옴). 각 reviewer는 독립적인 matrix job으로 plain `claude-code-action` 프롬프트를 실행하여 `findings/<reviewer>.json`을 작성하며, **in-run subagent가 불필요**하므로 `--agents`/`Agent` passthrough 위험이 사라집니다.

---

## 7. 모달 분류 ("단일 바이트 상한선 적용" 대체)

100KB 상한선은 "텍스트를 LLM에 전달하는 파일"에만 적용해야 하며, 이미지에는 적용하지 않아야 합니다.

| 파일 유형 | 처리 방식 | 100KB 바이트 상한선 |
|---|---|---|
| 텍스트 유형（code/doc/spec/`.md`） | 텍스트로 읽기; 초과 시 → **분할 또는 요약 후 심층 독해 지정**, 묵시적 폐기 안 함 | 적용（초과 시 → 분할） |
| 벡터/텍스트형 플로우 차트（`.svg`/`.mmd`/`.dot`/`.puml`） | **원시 코드 텍스트**로 읽기（의미 diff 가능） | 적용（일반적으로 매우 작음） |
| 래스터 이미지（png/jpg/webp…） | 바이트 크기 무관; **크기/메가픽셀 예산** 사용, vision 전달 전 downscale | **미적용** |

핵심: visual reviewer의 대부분 작업은 이미지를 "보는" 것이 불필요합니다——
- 중복 이미지 → 파일 해시 (정확/지각적 해시)
- 고아 이미지 → 참조 관계 그래프
- 명명/크기 규범 → 메타데이터
- **"이미지 내용이 디자인/스펙을 충족하는지"만 vision 전송 (사전 downscale)**

건너뛰는 유일한 경우는 처리 불가능한 초대형 불명 binary이며, 보고서에 `미검사: 초대형 binary`로 명시합니다. 묵시적으로 처리하지 않습니다.

---

## 8. 복원력 / 강등 처리

| 실패 시나리오 | 처리 방법 |
|---|---|
| 특정 reviewer matrix step 중단/타임아웃 | 해당 step이 `status:"failed"`, `findings:[]` 출력（matrix `fail-fast: false`）; 나머지 step 정상 진행; 보고서와 이슈에 "이번 실행에서 X 누락" 명시 |
| Anthropic API 일시적 오류 | 해당 step 재시도（지수 백오프, 최대 2회）; 그래도 실패 시 강등 |
| Synthesis step 실패 | 강등: Report가 raw findings만 표시（교차 영역 주제/서술 없음）, 전체 run을 실패로 만들지 않음 |
| 모든 reviewer 실패 | workflow 실패, 빈 이슈 생성 안 함 |
| Discovery 스캔 결과 파일 0개 | 정상 종료, 로그 기록, 오류 아님 |

원칙: Review/Synthesis 단계의 서브 실패는 모두 격리 강등 처리; 확정적 골격(Discovery/Consolidate/Report) 실패 시에만 전체 run을 실패로 처리합니다.

---

## 9. 비용 제어

- 파일당 100KB 상한선 + binary/lockfile/빌드 산출물 건너뜀 (§5, §7)
- **계층적 읽기 전송**: 먼저 목록 + 요약을 전송하고, reviewer가 심층 독해할 항목을 지정. 무분별하게 전체 텍스트를 전달하지 않음
- `max_files_per_reviewer` 안전 밸브 (기본값 300); 초과 시 "최근 커밋 접촉 + 높은 참조 빈도" 기준으로 상위 N개 선택, 보고서에 "잘림" 명시
- HTML / 이슈 조립은 순수 텍스트 처리로 **LLM 비용 없음**

---

## 10. 테스트 전략

테스트 샘플: 원격 실제 저장소 **https://github.com/wei18/Sudoku** (자체 fixture 대체).

- **확정적 계층 → 단위 테스트 (TDD)**: Discovery 분류, Consolidate 중복 제거 정렬, HTML/이슈 조립. LLM 미사용.
- **LLM 계층 → 계약 테스트**: subagent 출력이 **findings 스키마를 충족하는지** 검증 (필드 완전성, severity/confidence/ssot_direction이 유효한 값 범위 내에 있는지). 내용의 자구 단언은 하지 않음.
  - CI: **녹화된 가짜 response**를 사용하여 스키마 계약 테스트 (비용 절감, 안정성).
  - 실제 API 호출: 수동 / 릴리스 전 smoke 테스트만.
- **엔드-투-엔드 smoke**: Sudoku 저장소에서 전체 action을 실행하고, HTML/이슈 존재 여부, findings의 스키마 준수 여부, 합리적인 수의 문제 감지 여부를 단언 (자구 단언 불필요).

---

## 11. 범위 경계 (첫 번째 버전 미구현)

- 자동 수정 PR (README 자동 수정/고아 파일 삭제) ——2번째 버전에서 검토
- 동적 커스텀 reviewer——i18n 내장으로 충족
- PR 증분 모드——전체 스캔 우선
- SSOT 선언 파일——순수 추론으로 대체
