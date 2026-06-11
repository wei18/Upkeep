# 왜 Upkeep은 재사용 가능한 workflow인가 (step action이 아니라)

대부분의 GitHub Actions는 **step**으로 사용됩니다:

```yaml
steps:
  - uses: actions/checkout@v4
```

Upkeep은 workflow 파일을 가리키는 **job**으로 사용됩니다:

```yaml
jobs:
  audit:
    uses: wei18/upkeep/.github/workflows/audit.yml@v2
```

두 번째 형태는 흔히 보는 `- uses: owner/action@v1` 옆에 두면 낯설어서, 왜 그런지 묻게 됩니다. 이는 **재사용 가능한 workflow**(`on: workflow_call`)의 표준이자 공식 문서에 기재된 구문입니다 — [GitHub: Reuse workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows) 참고. 아래에 Upkeep이 왜 이렇게 설계되었는지 설명합니다.

## 이유: 병렬·장애 격리된 reviewer에는 `strategy.matrix`가 필요하다

Upkeep은 reviewer 팀을 디스패치합니다. 각 reviewer가 다음과 같기를 원합니다:

- **병렬**로 실행될 것 — 전체 감사가 단일 reviewer 실측 시간의 6배가 걸려서는 안 됩니다. 그리고
- **장애 격리**될 것 — 한 reviewer의 실패(타임아웃, API 오류)가 나머지를 중단시켜서는 안 됩니다.

"같은 단위를 병렬·독립적으로 여러 번 실행"하는 GitHub 네이티브 프리미티브가 바로 `strategy.matrix`입니다. **matrix는 job 수준의 기능**이며, job과 matrix를 선언할 수 있는 것은 *workflow*뿐이고 *action*은 할 수 없습니다. reviewer를 병렬·격리된 여러 matrix job으로 팬아웃하려면 Upkeep은 재사용 가능한 workflow여야 합니다.

## 왜 그냥 action으로 배포하지 않는가?

action에는 두 종류가 있는데, 둘 다 이 팬아웃을 표현할 수 없습니다:

- **JavaScript / Docker action** — 단일 진입점(예: `main: dist/index.js`). 다른 action을 `uses:`할 수 없으므로 LLM 작업을 [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action)에 위임하지 못하고 직접 Claude를 호출해야 하며, 게다가 job을 병렬로 실행할 수도 없습니다.
- **Composite action** — **하나의** job 안에서 *step* 시퀀스로 실행됩니다. 다른 action을 `uses:`*할 수 있어*(그래서 `claude-code-action`을 호출 가능) matrix가 없으므로 reviewer가 단일 job 안에서 **순차적**으로 실행됩니다.

따라서 composite action(`- uses: wei18/upkeep@v2`)도 *가능*합니다 — reviewer가 순차가 되는 대가로. Upkeep은 reviewer를 병렬·각자 격리로 유지하기 위해 의도적으로 재사용 가능한 workflow 형태를 선택했습니다. 예약 감사라면 느린 순차 경로도 허용 가능하지만, 우리는 병렬성과 깔끔한 장애 격리를 우선했습니다.

## 실제로 포기하는 것

호출부 구문뿐입니다. `- uses: owner/action@ref` 대신 `jobs.<id>.uses: owner/repo/.github/workflows/file.yml@ref`를 사용합니다. 그 외에는 모두 action과 동일합니다: `with:`로 inputs, `secrets:`로 secrets, `@v1`로 버전 고정.
