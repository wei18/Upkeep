# Upkeep — 設計ドキュメント

- ステータス：リリース済み。本 spec は現在の挙動を記述する。
- 配置：リポジトリ `wei18/upkeep`。英語 base：`docs/en/design.md`、各言語の翻訳：`docs/<locale>/design.md`（§6 参照）
- 自己制約：**本 spec は SSOT であり、実装に追随して常に最新を維持すること**（このツール自体がドリフトを検出するものであり、spec 自身がドリフトしてはならない）

---

## 0. 目標

**再利用可能な GitHub Workflow（`on: workflow_call`）**——任意のリポジトリが自身のワークフロー内で job レベルの `uses: wei18/upkeep/.github/workflows/audit.yml@v2` として参照できる。リポジトリの内容をスキャンし、それぞれ専門性を持つ一連のサブエージェント reviewer を起動して、コード・ドキュメント・仕様・ビジュアル図・アイコン・フロー等のリソースが以下の条件を満たすか検査する：

- up-to-date であるか（実際のコードや最近のコミットとドリフトしていないか）
- リポジトリ**自身**の規約に準拠しているか
- 重複ファイルがないか
- 参照されていない（孤立した）リソースがないか

出力：HTML 詳細レポート（アーティファクト）＋ GitHub トラッキング issue（サマリーエントリポイント）。

コア原則：**設定より規約**——リポジトリの現状から推論できることは、手動での入力を要求しない。設定ファイル自体が古くなることもドリフトの原因となるため、これを極力避ける。

---

## 1. アーキテクチャと実行フロー

形態：**再利用可能 workflow**（`.github/workflows/audit.yml`、`on: workflow_call`）、内部で公式 `claude-code-action` を LLM エンジンとして使用。呼び出し元が `CLAUDE_CODE_OAUTH_TOKEN` シークレットを提供する必要がある（`secrets: inherit` または明示的に渡す）。
> composite action を採用しない理由：composite action は単一 job のステップシーケンスであり、**`strategy.matrix` を使用できない**。matrix（各 reviewer を並列 job として実行）は workflow job 層でのみ可能なため、再利用可能 workflow を採用している（GitHub 公式ドキュメントで確認済み）。

**オーケストレーションモデル：fan-out → reduce（matrix + synthesis）、LLM リードなし。** 有効化された各 reviewer は独立した matrix **job** を実行する（1 つの `claude-code-action` ステップを含む。`fail-fast: false` + `continue-on-error` で障害を隔離）。各 reviewer は構造化された findings を出力し、その後 1 つの synthesis job（単一の LLM）が全ての findings を読み込み、セマンティックレベルでの横断的な関連付けを行う。「単一 run 内でサブエージェントを spawn する」方式には依存しない（その能力は実証されているが、job 単位の方が決定性・隔離性・ゼロ残留リスクの面で優れている）。

トリガー：reusable workflow が宣言するのは `on: workflow_call` のみであり、トリガーは呼び出し元の workflow が決める——通常は `schedule`（cron による定期フルスキャン）と `workflow_dispatch`（手動実行）の組み合わせである。この workflow にスコープ用の input はなく、実行は常にフルスキャンとなる。
> 「重複ファイル / 孤立ファイル / グローバル up-to-date」はグローバルな視点が必要であり、PR 差分では対応できないため、フルスキャンを主とする。

単一 run のデータフロー：

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

要点：
- Discovery / Consolidate / Report は**確定的なオーケストレーション骨格**；Review と Synthesis は LLM。
- **LLM リードなし**：オーケストレーション = GHA workflow（matrix）＋ Node。Review フェーズの各 reviewer は完全独立（相互通信不要）；横断的な俯瞰は Synthesis という reduce ステップで実現。
- findings は統一スキーマを使用し、Synthesis と Consolidate がいずれも機械的に処理できるようにする。

### ローカル実行（skill / スクリプト）

同じパイプラインは `scripts/local-audit.sh <target>` でローカルでも実行できる：discovery → 並列の `claude -p` レビュアーサブプロセス → synthesis → report。中間生成物（inventory、prompts、findings、synthesis）はすべて `mktemp` の作業ディレクトリに置かれ、`--add-dir` で Claude に許可される——対象リポジトリには何も書き込まない。ローカル実行でも同じセルフコンテインドな HTML レポートを生成する。GitHub issue の upsert は行わず、issue の markdown をターミナルサマリーとして出力する。`skills/upkeep-audit/SKILL.md` はこのスクリプトの薄い Claude Code ラッパーで、`~/.cache/upkeep` のクローンを維持し、監査を実行し、findings をチャットで要約する。この skill は 3 つの方法で配布され、いずれも同じディレクトリを指す：Claude Code plugin として（リポジトリルートの `.claude-plugin/marketplace.json` が `skills/upkeep-audit/` を `upkeep` という名前の single-skill plugin として登録し、`/plugin install upkeep@upkeep` でインストール）、`npx skills add wei18/upkeep --skill upkeep-audit` 経由（vercel-labs/skills のフラットレイアウト）、または `~/.claude/skills/` への手動コピー。配布はあくまでパッケージングであり——CI workflow は引き続き直接のパイプラインエントリのままで、skill を経由しない。

### Marketplace Composite Action

3 つ目の統合パスとして、同じエンジンをリポジトリルートの composite action（`action.yml`）としてパッケージ化し、おなじみの `- uses: wei18/upkeep@v2` step 構文と [GitHub Marketplace](https://github.com/marketplace) への掲載を可能にする。composite action は `strategy.matrix` を使えない単一 job であるため、その `discovery` → `reviewer`（×7）→ `synthesis` → `report` の各ステップは並列ではなく順番に実行される——エンジンと入力は同じだが、有効な reviewer が多いリポジトリでは実行が遅くなる。上記の reusable workflow が主要なパスであり続ける理由は `docs/ja/why-reusable-workflow.md` を参照。ここでの配布も skill と同様にあくまでパッケージングであり、`action.yml` は reusable workflow が使うのと同じ `.github/actions/<x>@v2` サブアクションを呼び出している。

---

## 2. Reviewer チーム

組み込みで **7 名**（6 名有効、1 名無効）：

| Reviewer | スコープ | 主な検出対象 | デフォルト |
|---|---|---|---|
| `docs_staleness` | README、ドキュメント、コメント、**多言語 README/doc バリアント** | 内容の陳腐化、コードとのドリフト、リンク切れ、**多言語版とベースの非同期** | on |
| `code_hygiene` | ソースコード | デッドコード、未使用ファイル/関数、spec との不一致、明らかなコードスメル | on |
| `spec_flow` | spec、フローチャート、ステートマシン | フローと実装の不一致、spec の陳腐化 | on |
| `visual_icon` | 画像、アイコン、デザインアセット | 未使用アセット、重複画像、サイズ/命名規約の違反 | on |
| `duplicate_orphan` | リポジトリ全体 | 重複ファイル、孤立ファイル、参照されていないリソース | on |
| `convention` | リポジトリ全体 | リポジトリ自身の skills/workflows/CLAUDE.md 規約違反 | on |
| `i18n` | ローカライズ文字列、`.lproj` 等 | 翻訳欠落、未使用キー、ベースとの非同期 | **off** |

動的なカスタム reviewer はサポートしない（§11）。組み込みの `i18n` reviewer（デフォルト無効）が一般的なニーズをカバーする。

### Rubric の三層合成（優先度：低 → 高）

```
Built-in default rubric (shipped with the action; defines what this specialty looks for)
   ⊕ repo-convention auto-discovery (the domain-relevant parts of
                         CLAUDE.md / .claude/skills / .claude/workflows)
   ⊕ audit.yml explicit override (the repo file pointed to by reviewers.<name>.rubric) ← highest priority
```

リポジトリが独自の基準を持つ場合はそれを優先する。`convention` はほぼ全面的にリポジトリ自身の規約に依存し、`visual_icon` は組み込みデフォルト＋リポジトリのデザイン規約（存在する場合）に主に依存する。

**Reviewer rubric の言語（`rubric_lang`）**：組み込み rubric はロケールごとに `reviewers/<locale>/` に配置され、`en` と `zh-TW` の 2 セットがある。`rubric_lang` workflow input（デフォルト `en`）が、reviewer と synthesis が使用するセットを選択する。それ以外の値を指定すると対応する prompt ファイルが存在しないため、すべての reviewer と synthesis ステップが失敗する。

### 2.1 多言語ドキュメント同期検出（multilingual doc-set）

`docs_staleness` が担当する（`i18n` ではない——`i18n` はコード層のローカライズ文字列（`.lproj`/`Localizable.strings` 等）を管理し、ドキュメント翻訳のドリフトはドキュメントの範疇に属する）。

- **ディレクトリ規約**：多言語ドキュメントは `docs/<locale>/<name>.md`（例：`docs/zh-TW/overview.md`）に配置する。唯一の例外はリポジトリルートの `README.md`＝**英語ベース**（GitHub の慣例）であり、各言語の訳はそれぞれ `docs/<locale>/README.md` に置く。
- **ベース言語**：`en`（ルートの `README.md` と `docs/en/*` が権威ある情報源）。
- **対応言語（最大 6）**：`en`（ベース）、`zh-TW`、`zh-CN`、`ja`、`ko`（6 番目は予約）。
- **検出**：ベース（`docs/en/<name>.md`、README の場合はルートの `README.md`）を基準として、各 `docs/<locale>/<name>.md` に対して「遅延/欠落/陳腐化」を報告する。§3 の原則に従い、証拠を付与する（git 最新度：ベースが更新されたが当該言語の訳が追随していない）。「翻訳が更新すべき側である」と決めつけない。ただし、ベースの方が新しい場合は通常、翻訳が遅れている傾向にある。
- **グルーピング**：reviewer は「`docs/<locale>/` サブディレクトリをまたいだ同名ファイル」でグループ化する（README についてはルートの `README.md` と `docs/<locale>/README.md` を同グループとして扱う）。
- **Dogfood**：本リポジトリ自身の全ユーザードキュメント（README、overview、design、why-reusable-workflow）は `docs/<locale>/` に多言語化されており、この機能の実際のテストサンプルとしても機能する（§10 参照）。

---

## 3. SSOT 処理原則（情報源を決めつけない）

問題：spec/コードが必ずしも SSOT とは限らない。**spec 自体が古くなっているケースもある**。方向を固定でデフォルトにすると誤検知が生じる。

原則：**reviewer は SSOT を決めつけず、「乖離」のみを検出し、方向の判断は証拠＋分級による裁定に委ねる。**

1. **乖離を検出し、断定しない**：「A は X、B は Y、不一致」と報告する。「B が古い」とは言わない。
2. **証拠シグナルを付与する**：git の最終更新時刻 / コミットの最新度、参照回数、参照の方向性。
3. **分級による裁定**：
   - 証拠が強い場合（例：あるファイルが半年間未更新、関連コードが先週大幅に変更された）→ `ssot_direction` を `stale_a` または `stale_b` に設定し（§4）、提案内で方向を明示する（「README が古い、更新を推奨」）。それでも人による確認が必要である。
   - 証拠が弱い場合 → `ssot_direction` を `uncertain` に設定し、方向の判断は人に委ねる旨を提案に記す。
   - **いかなる状況でも自動修正はしない**（自動修正はスコープ外、§11 参照）。
4. **SSOT を宣言ファイルに依存しない**：方向は全て推論で決定し、宣言ファイル自体が古くなるリスクを避ける。固定ポリシーを持つリポジトリは、上書き用の rubric（`reviewers.<name>.rubric`、§5）にそのポリシーを記述できる（任意であり、非推奨）。

---

## 4. findings スキーマ

各 reviewer は `findings/<reviewer>.json` を 1 ファイル書き出し、問題ごとに 1 レコードを記録する：

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

- `status`：`ok` または `failed`。失敗した reviewer は `status: "failed"` と `findings: []` を書き出し、他の reviewer には影響しない。
- `file`：主となるファイル。複数ファイルにまたがる問題は主となるファイルに記録し、残りは `related` に列挙する。
- `related`：関連するその他のファイル。空でもよい。比較の相手側となるファイルを先頭に置く。
- `category`：`staleness`、`duplicate`、`orphan`、`convention`、`inconsistency`、`i18n_sync`、`other` のいずれか。
- `problem`：人間が読める問題の説明。
- `evidence`：裏付けとなる証拠（git の時刻、参照関係、具体的な不一致箇所）。
- `suggestion`：修正の提案。分級による裁定のもとで方向を示すことがある（§3）。
- `severity`、`confidence`：それぞれ `low`、`medium`、`high` のいずれか。
- `ssot_direction`：次の 4 つの値のいずれか。
  - `stale_a`：`file` が古い側である。
  - `stale_b`：`related` の先頭のファイルが古い側である。
  - `uncertain`：両者は食い違っているが、どちらが古いかは証拠から判断できない。
  - `n/a`：比較すべき 2 つの側がない問題である。

`category`、`severity`、`confidence` の各値の判断基準は 1 か所、reviewer prompt（`reviewers/<locale>/_reviewer-prompt.md`）でのみ定義する。`src/findings.ts` が各ファイルを許容値に照らして検証し、検証に失敗したファイルは `failed` の結果に置き換えられる。

**Consolidate の重複排除/ソート（確定的処理）**：`file` + `category` をキーとして reviewer をまたいだ重複をマージする——同キーの「代表 finding」= severity×confidence が最高のもの（同点の場合は reviewer の列挙順を安定した tiebreak として使用）。`reviewers[]` はそのキーを報告した全 reviewer の和集合、`related[]` は和集合を取る。ソートキー = severity 降順 → confidence 降順 → file 昇順。

### 4.1 synthesis 出力

Synthesis ステップは全 `findings/*.json` + inventory を読み込み、`synthesis.json` を出力する。**findings の参照はファイルパスで行う（整数インデックスを使用しない——LLM に対してより安定的で人間にも読みやすい）**：

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

- `themes`：reviewer をまたぐ系統的なテーマ。`title` は系統的な問題の要約、`narrative` はそれらの finding が同じ根本原因を指す理由、`related_files` はテーマが対象とするファイルパス、`priority` は `low`、`medium`、`high` のいずれかである。
- `semantic_duplicates`：同じ問題を指す finding キーのグループ。各キーの形式は `reviewer|file|category` である。Consolidate は各グループを 1 件の finding にマージする。
- `executive_summary`：全体の健全性を 1 段落でまとめた要約。
- `status`：`ok` または `failed`。synthesis が失敗した場合は `themes: []` を書き出す。

レポートは raw findings と synthesis を両方使用する。synthesis が失敗または存在しない場合は raw findings のみの表示にフォールバックする（テーマ/エグゼクティブサマリーなし）。

---

## 5. 設定ファイル `.claude/audit.yml`（全て任意、存在しなくても完全動作）

`scan` と `ssot` は**設定に含めない**（自身が古くなるため）。代わりに自動推論する。

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

すべてのキーは任意である：

- `version`：設定スキーマのバージョン。現在は `1`。
- `ignore`：glob パス。一致したファイルは inventory から除外され、どの reviewer にも見えなくなる。デフォルト：なし。
- `reviewers.<name>.enabled`：reviewer の有効・無効を切り替える。デフォルト：`i18n` 以外はすべて有効。記載のない reviewer はデフォルトのままとなり、未知の名前は無視される。
- `reviewers.<name>.paths`：glob パス。設定すると、その reviewer の target ファイルは、ファイル種別による既定の選択（§2 の表の「スコープ」列）に代わり、inventory 内で一致したファイルになる。
- `reviewers.<name>.rubric`：rubric ファイルのリポジトリルートからの相対パス。reviewer はこれを最優先の rubric 層として読む（§2）。
- `report.min_severity`：`low`、`medium`、`high` のいずれか。この値未満の finding は tracking issue に含めない。HTML レポートにはすべての finding が残る。デフォルト：`low`。camelCase 表記の `minSeverity` も受け付ける。

Glob 構文：`*` は 1 つのパスセグメント内に一致し、`**` はセグメントをまたいで一致し、`?` は 1 文字に一致する。

issue のラベルは設定キーではない。`issue_label` workflow input（デフォルト `audit`）で指定する。

### 自動推論（設定不要）

- **スキャン範囲**：`git ls-files --cached --others --exclude-standard` が列挙するすべてのファイル（追跡済みと未追跡のファイル。`.gitignore` に従う）から、`ignore` の glob に一致するものを除いたもの。lockfile のファイルカテゴリは `other` となるため、リポジトリ全体を見る reviewer（`duplicate_orphan`、`convention`）だけが受け取る。100KB を超えるテキストファイルにはフラグが付くだけで、スキップはされない（§7）。
- **SSOT 方向**：全て証拠による推論（§3）、宣言ファイルなし。

---

## 6. リポジトリの配置（確定）

Upkeep は `uses:` で参照されるため、独立したリポジトリ `wei18/upkeep` に置く（`uses: wei18/upkeep@v2`）。

構造：

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

> アーカイブに関する注記：`docs/archive/plans/` と `docs/superpowers/` は、Upkeep の構築過程を残した履歴記録である。多言語化されず、どのナビゲーション索引からもリンクされず、現行のルールでもない——現行のルールは本 spec である。`.claude/audit.yml` は、この 2 つの `plans/` ディレクトリを自己監査から除外している。

> サブ action の仕組み：再利用可能 workflow の job は**呼び出し元**の checkout 上で実行される。Upkeep 自身のコード（src/、reviewers/）は `uses: wei18/upkeep/.github/actions/<x>@v2` によって取り込まれる（GitHub が自動的に Upkeep リポジトリを取得）。各 reviewer は独立した matrix job で plain の `claude-code-action` プロンプトを実行する（`findings/<reviewer>.json` を書き込む）。**run 内でのサブエージェント spawn は不要**なため、`--agents`/`Agent` パススルーのリスクは発生しない。

---

## 7. モーダル分流

Discovery はすべてのファイルに `modality` を 1 つ割り当てる。100KB 上限は reviewer がテキストとして読むファイルにのみ適用し、画像には適用しない。

| `modality` | 対象 | reviewer の扱い |
|---|---|---|
| `raster_image` | `.png`、`.jpg`、`.jpeg`、`.gif`、`.webp`、`.bmp`、`.tiff`、`.heic`、`.ico`、`.icns` | バイト上限なし。メタデータで判断し、下記の唯一のケースでのみ画像として開く |
| `vector_diagram` | `.svg`、`.mmd`、`.dot`、`.puml`、`.plantuml` | **ソースコードテキスト**として読み込む（セマンティック diff 可能）。100KB を超えると inventory が `oversizedText: true` を設定する |
| `binary` | 先頭 8000 バイト内に NUL バイトを含むその他のファイル | メタデータ（`hash`、`sizeBytes`、`referencedBy`）のみで判断する |
| `text` | 残りのすべてのファイル | テキストとして読み込む。100KB を超えると inventory が `oversizedText: true` を設定する |

`oversizedText` は inventory 内のフラグにすぎない：サイズを理由にファイルが切り詰め・チャンク分割・要約・破棄されることはない。reviewer prompt は、フラグの付いたファイルを分割して読むよう reviewer に指示する。

visual reviewer の作業の大部分は実際に「画像を見る」必要がない：
- 重複画像 → ファイルハッシュ（完全一致）
- 孤立画像 → 参照関係グラフ
- 命名/サイズ規約 → メタデータ
- **「画像の内容がデザイン/spec と一致するか」の判断のみ画像を開く必要がある**。rubric はこれを少数の疑わしいアセットに限定している

---

## 8. レジリエンス / フォールバック

| 障害シナリオ | 対処方法 |
|---|---|
| ある reviewer がクラッシュ・タイムアウトする、または不正な出力を書き出す | その reviewer の結果は `status:"failed"`・`findings:[]` になる（matrix の `fail-fast: false`）；他の reviewer は通常通り続行；レポートと issue は「不完全な実行」の警告で失敗した reviewer を明記する |
| Synthesis ステップの失敗 | フォールバック：レポートは raw findings のみ表示（横断的テーマ/ナレーティブなし）、run 全体を失敗にしない |
| 全 reviewer が失敗 | run は完了する：レポートと issue は finding なしで生成され、「不完全な実行」の警告がすべての reviewer を列挙する |
| Discovery でファイルが 0 件 | 正常終了、ログを残す、エラーではない |

原則：Review/Synthesis フェーズのサブ障害は全て隔離してフォールバック；確定的骨格（Discovery/Consolidate/Report）の障害が run 全体を失敗とする。

---

## 9. コスト管理

- reviewer が受け取るのは inventory（メタデータ）と target ファイルのリストであり、ファイルの内容ではない。prompt は、メタデータで疑わしいファイルを絞り込み、それらだけを詳細に読むよう指示する
- `max_turns`（デフォルト 30）が、各 reviewer 呼び出しと synthesis 呼び出しの turn 数を制限する
- `.gitignore` または `ignore` で除外されたファイルは inventory に入らない（§5）
- HTML / issue の組み立ては純テキスト処理であり、**LLM コストはゼロ**

---

## 10. テスト戦略

テストサンプル：リモートの実際のリポジトリ **https://github.com/wei18/Sudoku**（自前 fixture の代替）。

- **確定的層 → ユニットテスト（TDD）**：Discovery の分類、Consolidate の重複排除・ソート、HTML/issue の組み立て。LLM には触れない。
- **LLM 層 → コントラクトテスト**：サブエージェントの出力が **findings スキーマに準拠していること**を検証する（フィールドの網羅性、severity/confidence/ssot_direction が合法な値域内にあること）。内容を逐一アサートしない。
  - CI：**録音済みのフェイクレスポンス**を使用してスキーマコントラクトテストを実施（コスト節約・安定性向上）。
  - 実際の API への接続：手動 / リリース前スモークテストのみ。
- **エンドツーエンドスモーク（手動、CI には含まれない）**：Sudoku リポジトリに対して workflow 全体を実行し、HTML artifact と issue の存在、findings のスキーマ準拠、妥当な数量の問題検出を確認する（逐一アサートしない）。
- **Dogfood**：`.github/workflows/self-audit.yml` が本リポジトリに対して毎週監査を実行する。

---

## 11. スコープ境界（対象外）

- 自動修正 PR（README の自動更新、孤立ファイルの自動削除）——計画なし。Upkeep は出力のみを行う
- 動的なカスタム reviewer——reviewer の構成は固定。組み込み reviewer は `reviewers.<name>.paths` と `reviewers.<name>.rubric`（§5）で調整する
- PR 差分モード——実行は常にフルスキャン
- SSOT 宣言ファイル——方向は証拠から推論する
