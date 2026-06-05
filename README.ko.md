# Upkeep

저장소의 문서, 명세, 에셋이 실제 코드와 일치하는지 주기적으로 검사하여 드리프트가 누적되기 전에 잡아내는 재사용 가능한 GitHub Actions workflow입니다.

## 주요 기능

- 저장소를 스캔하고, Anthropic의 `claude-code-action` 기반 **전문화된 AI 리뷰어 팀**을 병렬로 실행합니다.
- 코드와 어긋난 오래된 문서, 구현과 맞지 않는 명세, 중복·고아 파일, 컨벤션 위반, 동기화가 깨진 번역 문서를 탐지합니다.
- **근거와 함께 불일치를 보고합니다** — 어느 한 쪽이 항상 정답이라고 가정하지 않습니다.
- **파일을 수정하거나 삭제하지 않습니다** — 출력 전용입니다.
- 독립 실행형 **HTML 보고서**(workflow artifact)와 **지속적인 GitHub 추적 이슈**(upsert 방식, 중복 없음)를 생성합니다.

## 사용 방법

저장소에 `.github/workflows/audit.yml`을 생성합니다.

```yaml
name: repo audit
on:
  schedule:
    - cron: '0 3 * * 1'   # weekly, Monday 03:00 UTC
  workflow_dispatch:        # also run manually

permissions:
  contents: read
  issues: write
  id-token: write

jobs:
  audit:
    uses: wei18/upkeep/.github/workflows/audit.yml@v1
    with:
      model: claude-opus-4-8     # optional
      issue_label: audit         # optional; default: audit
    secrets:
      claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

**사전 요구 사항**

- `CLAUDE_CODE_OAUTH_TOKEN`라는 이름의 저장소 secret — 로컬에서 `claude setup-token`을 실행하여 생성하십시오(Claude Pro/Max 구독 필요, 사용량은 구독에서 차감됩니다). 사용량 기반 API 과금을 원하신다면 workflow input을 `anthropic_api_key`로 교체하십시오.
- 위에 표시된 `permissions` 블록 (`contents: read` + `issues: write`).

**출력**

- `audit` 레이블이 붙은 GitHub 이슈 — 매 실행마다 동일한 이슈가 업데이트됩니다(upsert). 중복 생성되지 않습니다.
- `report-html` workflow artifact로 업로드되는 독립 실행형 HTML 보고서.

## 리뷰어

| 이름 | 기본값 | 검사 항목 |
|---|---|---|
| `docs_staleness` | 활성 | 코드와 어긋난 문서; 동기화가 깨진 다국어 README 및 번역 문서 |
| `code_hygiene` | 활성 | 데드 코드, 미사용 export, 영구적으로 남겨진 주석 처리 블록 |
| `spec_flow` | 활성 | 구현과 더 이상 일치하지 않는 명세, 다이어그램, 플로우차트 |
| `visual_icon` | 활성 | 오래되었거나 불일치하는 이미지 및 아이콘 |
| `duplicate_orphan` | 활성 | 중복 파일 및 커밋은 되어 있지만 참조되지 않는 고아 에셋 |
| `convention` | 활성 | 저장소 자체 컨벤션 위반 (CLAUDE.md, `.claude/skills`, workflow) |
| `i18n` | **비활성** | 로케일 파일 간 국제화 일관성 |

## 설정

모든 설정은 선택 사항입니다 — 위의 caller workflow 외에 별도 설정 없이 바로 사용할 수 있습니다. 리뷰어를 활성화하거나 조정하려면 `.claude/audit.yml`을 생성하세요. 전체 스키마와 옵션은 [`docs/design.md`](docs/design.md)를 참고하세요.

## 문서

- [`docs/overview.md`](docs/overview.md) — 파이프라인 동작 방식
- [`docs/design.md`](docs/design.md) — 전체 설계 참고 문서

## 번역된 README

- [繁體中文](README.zh-TW.md)
- [简体中文](README.zh-CN.md)
- [日本語](README.ja.md)
- [한국어](README.ko.md) (현재 문서)
