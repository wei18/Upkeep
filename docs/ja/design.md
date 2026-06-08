# Upkeep — 設計ドキュメント

- ステータス：実装済みで v1 としてリリース — 本 spec はリリース済みの挙動を追跡する
- 日付：2026-06-04（設計）；2026-06-05 リリース
- 配置：独立リポジトリ `upkeep/`、仕様は `docs/design.md`（§6 参照）
- 自己制約：**本 spec は SSOT であり、実装に追随して常に最新を維持すること**（このツール自体がドリフトを検出するものであり、spec 自身がドリフトしてはならない）

---

## 0. 目標

**再利用可能な GitHub Workflow（`on: workflow_call`）**——任意のリポジトリが自身のワークフロー内で job レベルの `uses: wei18/upkeep/.github/workflows/audit.yml@v1` として参照できる。リポジトリの内容をスキャンし、それぞれ専門性を持つ一連のサブエージェント reviewer を起動して、コード・ドキュメント・仕様・ビジュアル図・アイコン・フロー等のリソースが以下の条件を満たすか検査する：

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

トリガー：`schedule`（cron による定期フルスキャン）＋ `workflow_dispatch`（手動、スコープパラメータ付き）。
> 「重複ファイル / 孤立ファイル / グローバル up-to-date」はグローバルな視点が必要であり、PR 差分では対応できないため、フルスキャンを主とする。

単一 run のデータフロー：

```
トリガー (schedule / workflow_dispatch)
  │
  ▼
[1] Discovery（確定的処理、LLM なし）
    repo をスキャン → ファイルリスト + モーダル分類(code/doc/spec/visual/flow/icon...)
    規約ソースを読み込む：CLAUDE.md、.claude/skills、.claude/workflows、
                .github/workflows、.claude/audit.yml(存在する場合)
  │
  ▼
[2] Review（matrix：有効化された各 reviewer に 1 つの claude-code-action ステップ）
    GHA matrix でネイティブ並列実行・障害隔離；唯一の LLM コスト集中箇所
    各ステップの入力：inventory + 担当ファイルサブセット + 合成 rubric（組み込みデフォルト ⊕ repo 規約）
    各自 findings/<reviewer>.json を出力（スキーマは §4 参照）
  │
  ▼
[3] Synthesis（単一の claude-code-action、唯一の「統合」を担う脳）
    全 findings/*.json + inventory を読み込む（簡潔な構造化素材、repo 全体の再読み込みなし）
    → セマンティックレベルでの横断的な関連付け、重複排除、システム的なテーマ、優先度のナレーティブ
    → synthesis.json
  │
  ▼
[4] Consolidate（確定的処理）
    findings と synthesis を機械的にマージ、キーの重複排除、ソート（severity × confidence）
  │
  ▼
[5] Report（確定的処理、LLM コストゼロ）
    ├─ セルフコンテインドな単一ファイル HTML レポートを生成 → アーティファクトとしてアップロード
    └─ トラッキング issue を作成/更新（markdown サマリー + HTML アーティファクトへのリンク）
```

要点：
- Discovery / Consolidate / Report は**確定的なオーケストレーション骨格**；Review と Synthesis は LLM。
- **LLM リードなし**：オーケストレーション = GHA workflow（matrix）＋ Node。Review フェーズの各 reviewer は完全独立（相互通信不要）；横断的な俯瞰は Synthesis という reduce ステップで実現。
- findings は統一スキーマを使用し、Synthesis と Consolidate がいずれも機械的に処理できるようにする。

---

## 2. Reviewer チーム

組み込みで **7 名**（6 名有効、1 名無効）：

| Reviewer | スコープ | 主な検出対象 | デフォルト |
|---|---|---|---|
| `docs_staleness` | README、ドキュメント、コメント、**多言語 README/doc バリアント** | 内容の陳腐化、コードとのドリフト、リンク切れ、**多言語版とベースの非同期** | on |
| `code_hygiene` | ソースコード | デッドコード、未使用ファイル/関数、spec との不一致 | on |
| `spec_flow` | spec、フローチャート、ステートマシン | フローと実装の不一致、spec の陳腐化 | on |
| `visual_icon` | 画像、アイコン、デザインアセット | 未使用アセット、重複画像、サイズ/命名規約の違反 | on |
| `duplicate_orphan` | リポジトリ全体 | 重複ファイル、孤立ファイル、参照されていないリソース | on |
| `convention` | リポジトリ全体 | リポジトリ自身の skills/workflows/CLAUDE.md 規約違反 | on |
| `i18n` | ローカライズ文字列、`.lproj` 等 | 翻訳欠落、未使用キー、ベースとの非同期 | **off** |

第一版では**動的なカスタム reviewer は実装しない**。i18n は組み込み（デフォルト無効）として用意することで一般的なニーズをカバーする（YAGNI）。

### Rubric の三層合成（優先度：低 → 高）

```
組み込みデフォルト rubric（action 同梱、その専門領域で何を検出するかを定義）
   ⊕ repo 規約の自動探索（CLAUDE.md / .claude/skills / .claude/workflows
                         のうち、その領域に関連するもの）
   ⊕ audit.yml での明示的指定（reviewers.<name>.rubric が指すリポジトリファイル）← 最高優先
```

リポジトリが独自の基準を持つ場合はそれを優先する。`convention` はほぼ全面的にリポジトリ自身の規約に依存し、`visual_icon` は組み込みデフォルト＋リポジトリのデザイン規約（存在する場合）に主に依存する。

**Reviewer rubric の言語（`rubric_lang`）**：組み込み rubric はロケールごとに `reviewers/<locale>/`（例：`reviewers/en/`、`reviewers/zh-TW/`）に配置される。`rubric_lang` workflow input（デフォルト `en`）が、reviewer と synthesis が使用するセットを選択する。

### 2.1 多言語ドキュメント同期検出（multilingual doc-set）

`docs_staleness` が担当する（`i18n` ではない——`i18n` はコード層のローカライズ文字列（`.lproj`/`Localizable.strings` 等）を管理し、ドキュメント翻訳のドリフトはドキュメントの範疇に属する）。

- **ディレクトリ規約**：多言語ドキュメントは `docs/<locale>/<name>.md`（例：`docs/zh-TW/overview.md`）に配置する。唯一の例外はリポジトリルートの `README.md`＝**英語ベース**（GitHub の慣例）であり、各言語の訳はそれぞれ `docs/<locale>/README.md` に置く。
- **ベース言語**：`en`（ルートの `README.md` と `docs/en/*` が権威ある情報源）。
- **対応言語（最大 6）**：`en`（ベース）、`zh-TW`、`zh-CN`、`ja`、`ko`（6 番目は予約）。
- **検出**：ベース（`docs/en/<name>.md`、README の場合はルートの `README.md`）を基準として、各 `docs/<locale>/<name>.md` に対して「遅延/欠落/陳腐化」を報告する。§3 の原則に従い、証拠を付与する（git 最新度：ベースが更新されたが当該言語の訳が追随していない）。「翻訳が更新すべき側である」と決めつけない。ただし、ベースの方が新しい場合は通常、翻訳が遅れている傾向にある。
- **グルーピング**：reviewer は「`docs/<locale>/` サブディレクトリをまたいだ同名ファイル」でグループ化する（README についてはルートの `README.md` と `docs/<locale>/README.md` を同グループとして扱う）。
- **Dogfood**：本リポジトリ自身の全ユーザードキュメント（README、overview、design、plans）は `docs/<locale>/` に多言語化されており、この機能の実際のテストサンプルとしても機能する（§10 参照）。

---

## 3. SSOT 処理原則（情報源を決めつけない）

問題：spec/コードが必ずしも SSOT とは限らない。**spec 自体が古くなっているケースもある**。方向を固定でデフォルトにすると誤検知が生じる。

原則：**reviewer は SSOT を決めつけず、「乖離」のみを検出し、方向の判断は証拠＋分級による裁定に委ねる。**

1. **乖離を検出し、断定しない**：「A は X、B は Y、不一致」と報告する。「B が古い」とは言わない。
2. **証拠シグナルを付与する**：git の最終更新時刻 / コミットの最新度、参照回数、参照の方向性。
3. **分級による裁定**：
   - 証拠が強い場合（例：あるファイルが半年間未更新、関連コードが先週大幅に変更された）→ 提案内で方向を明示する（「README が古い、更新を推奨」）が、それでも `needs-confirmation` を付与する。
   - 証拠が弱い場合 → 「ドリフト、方向は裁定待ち」とマークする。
   - **いかなる状況でも自動修正はしない**（自動修正は第二フェーズに持ち越し）。
4. **SSOT を宣言ファイルに依存しない**：方向は全て推論で決定し、宣言ファイル自体が古くなるリスクを避ける。固定ポリシーが真に必要なリポジトリのみ escape hatch で上書き可能（非推奨）。

---

## 4. findings スキーマ

各 reviewer は各問題に対して以下を出力する：

```jsonc
{
  "file": "path/to/file",          // 主体ファイル（複数ファイルにまたがる問題は主ファイルに記載、related で補足）
  "related": ["path/..."],          // 関連ファイル（空でも可）
  "reviewer": "docs_staleness",
  "category": "staleness | duplicate | orphan | convention | inconsistency | ...",
  "problem": "人間が読める問題の説明",
  "evidence": "裏付け証拠（git タイムスタンプ、参照関係、具体的な不一致箇所）",
  "suggestion": "推奨修正方法（分級裁定により方向を含む場合あり）",
  "severity": "high | medium | low",
  "confidence": "high | medium | low",
  "ssot_direction": "stale_a | stale_b | uncertain | n/a",
  "status": "ok"                    // reviewer レベル：ok | failed
}
```

各 reviewer ステップは `findings/<reviewer>.json` を 1 ファイル出力する：`{ reviewer, status: "ok"|"failed", findings: Finding[] }`（単一 reviewer が失敗した場合、`status:"failed"`・`findings:[]` となり、他には影響しない）。

**Consolidate の重複排除/ソート（確定的処理）**：`file` + `category` をキーとして reviewer をまたいだ重複をマージする——同キーの「代表 finding」= severity×confidence が最高のもの（同点の場合は reviewer の列挙順を安定した tiebreak として使用）。`reviewers[]` はそのキーを報告した全 reviewer の和集合、`related[]` は和集合を取る。ソートキー = severity 降順 → confidence 降順 → file 昇順。

### 4.1 synthesis 出力

Synthesis ステップは全 `findings/*.json` + inventory を読み込み、`synthesis.json` を出力する。**findings の参照はファイルパスで行う（整数インデックスを使用しない——LLM に対してより安定的で人間にも読みやすい）**：

```jsonc
{
  "themes": [                         // reviewer をまたいだシステム的なテーマ
    {
      "title": "システム的な問題の簡潔な説明",
      "narrative": "これらの finding が同一の根本原因を指している理由",
      "related_files": ["path/a", "path/b"],  // このテーマが対象とするファイルパス
      "priority": "high | medium | low"
    }
  ],
  "semantic_duplicates": [[ "reviewer|file|category", "reviewer|file|category" ]], // 意味的に重複する finding キーのグループ
  "executive_summary": "全体的な健全性を要約した一段落",
  "status": "ok"                      // synthesis 失敗時 → レポートは raw findings のみ出力
}
```

レポートは raw findings と synthesis を両方使用する。synthesis が失敗または存在しない場合は raw findings のみの表示にフォールバックする（テーマ/エグゼクティブサマリーなし）。

---

## 5. 設定ファイル `.claude/audit.yml`（全て任意、存在しなくても完全動作）

`scan` と `ssot` は**設定に含めない**（自身が古くなるため）。代わりに自動推論する。

```yaml
# .claude/audit.yml —— 全て任意；通常このファイルは不要
version: 1
ignore:                  # 任意: 監査全体から除外する glob パス（全 reviewer）
  - "docs/*/plans/**"    # 例: 監査したくないアーカイブ済み設計記録
reviewers:               # 「無効化/スコープ変更/i18n 有効化」するものだけ記述、それ以外はデフォルトのまま
  visual_icon: { enabled: false }
  i18n:        { enabled: true }
report:
  issue_label: "audit"   # デフォルトが "audit" のため、変更する場合のみ記述
  min_severity: "low"    # これ未満は issue に含まない（HTML 完全レポートには含まれる）
```

> 設定キーは `snake_case`（`issue_label`、`min_severity`）で示すが、`snake_case` と内部的な `camelCase`（`issueLabel`、`minSeverity`）の両方を受け付ける。

### 自動推論（設定不要）

- **スキャン範囲**：リポジトリの `.gitignore` に従う。binary / lockfile / ビルド成果物は自動スキップ。テキストファイルは組み込みで 100KB の上限を適用（§7 のモーダル分流参照）。
- **SSOT 方向**：全て証拠による推論（§3）、宣言ファイルなし。

---

## 6. リポジトリの配置（確定）

この action は `uses:` で参照できる形式で公開するため、独立したリポジトリとする。ローカルディレクトリは `/Users/zw/GitHub/Wei18/repo-audit-action/`（`git init` 済み）；**公開/パッケージ名は `Upkeep`**（`uses: wei18/upkeep@v1`）——ローカルフォルダ名と公開名が異なるのは意図的なものである。

想定される構造：

```
repo-audit-action/                   # ローカルディレクトリ（公開名 Upkeep）
├── .github/
│   ├── workflows/audit.yml          # 再利用可能 workflow（on: workflow_call）：jobs/matrix オーケストレーション
│   └── actions/                     # composite サブ action（workflow の job が uses で参照、Upkeep コードを内包）
│       ├── discovery/  reviewer/  synthesis/  report/
├── README.md                        # 英語ベース使用例（job レベルの uses: 例、secret/権限）＋言語切替リスト
├── docs/
│   ├── en/      README なし（ルートが en）；overview.md  design.md  why-reusable-workflow.md  plans/
│   ├── zh-TW/   README.md  overview.md  design.md  plans/
│   ├── zh-CN/ … ja/ … ko/   （同様に各言語一式）
│   └── （多言語ユーザードキュメントは全て docs/<locale>/；root README.md は en ベース）
├── reviewers/<locale>/              # 7 名の組み込み rubric + _reviewer-prompt + _synthesis-prompt、ロケールごと（en、zh-TW）；rubric_lang で選択
├── src/                             # discovery/consolidate/report/matrix/prompt-bundle 等の確定的 TS
└── test/                            # ユニット + コントラクト + e2e（サンプルは §10 参照）
```

> アーカイブに関する注記：`docs/<locale>/plans/` ツリーは、元の段階的な実装計画を意図的に**アーカイブ**したものです（ロケールごとに 1 セット）。どのナビゲーション索引からも意図的にリンクされておらず、その fenced ブロック（コードおよび埋め込みのドキュメントテンプレート）は zh-TW ソースから**逐語的に**保持されています——したがって、これらのファイルの空の `referencedBy` や fence 内の非英語テキストは想定どおりであり、ドリフトではありません。

> サブ action の仕組み：再利用可能 workflow の job は**呼び出し元**の checkout 上で実行される。Upkeep 自身のコード（src/、reviewers/）は `uses: wei18/upkeep/.github/actions/<x>@v1` によって取り込まれる（GitHub が自動的に Upkeep リポジトリを取得）。各 reviewer は独立した matrix job で plain の `claude-code-action` プロンプトを実行する（`findings/<reviewer>.json` を書き込む）。**run 内でのサブエージェント spawn は不要**なため、`--agents`/`Agent` パススルーのリスクは発生しない。

---

## 7. モーダル分流（「一律バイト上限」の代替）

100KB 上限は「LLM にテキストとして渡すファイル」にのみ適用すべきであり、画像には適用しない。

| ファイル種別 | 処理方法 | 100KB バイト上限 |
|---|---|---|
| テキスト系（code/doc/spec/`.md`） | テキストとして読み込む。上限超過時は**チャンク分割、または先に要約してから詳細読み込みを指示**（サイレントに破棄しない） | 適用（超過時→チャンク分割） |
| ベクター/テキスト形式のフローチャート（`.svg`/`.mmd`/`.dot`/`.puml`） | **ソースコードテキスト**として読み込む（セマンティック diff 可能） | 適用（通常は非常に小さい） |
| ラスター画像（png/jpg/webp…） | バイトサイズは無関係；**サイズ/メガピクセル予算**で管理、vision に送る前に downscale | **適用しない** |

重要：visual reviewer の作業の大部分は実際に「画像を見る」必要がない——
- 重複画像 → ファイルハッシュ（完全一致/知覚的ハッシュ）
- 孤立画像 → 参照関係グラフ
- 命名/サイズ規約 → メタデータ
- **「画像の内容がデザイン/spec と一致するか」の判断のみ vision を使用（downscale 後）**

スキップされる唯一のケースは処理不能な超大型の不明バイナリであり、レポートに `未検査：超大型バイナリ` と明記する（サイレントに無視しない）。

---

## 8. レジリエンス / フォールバック

| 障害シナリオ | 対処方法 |
|---|---|
| ある reviewer の matrix ステップがクラッシュ/タイムアウト | そのステップは `status:"failed"`・`findings:[]` を出力（matrix の `fail-fast: false`）；他のステップは通常通り続行；レポートと issue に「今回 X は欠落」と明記 |
| Anthropic API の一時的エラー | そのステップをリトライ（指数バックオフ、最大 2 回）；それでも失敗した場合にフォールバック |
| Synthesis ステップの失敗 | フォールバック：レポートは raw findings のみ表示（横断的テーマ/ナレーティブなし）、run 全体を失敗にしない |
| 全 reviewer が失敗 | workflow を fail とし、空の issue は作成しない |
| Discovery でファイルが 0 件 | 正常終了、ログを残す、エラーではない |

原則：Review/Synthesis フェーズのサブ障害は全て隔離してフォールバック；確定的骨格（Discovery/Consolidate/Report）の障害が run 全体を失敗とする。

---

## 9. コスト管理

- 100KB/ファイル上限 + binary/lockfile/ビルド成果物のスキップ（§5、§7）
- **段階的送信**：まずリストとサマリーを送り、reviewer が詳細読み込みを指定する方式とし、無差別な全文送信はしない
- HTML / issue の組み立ては純テキスト処理であり、**LLM コストはゼロ**

---

## 10. テスト戦略

テストサンプル：リモートの実際のリポジトリ **https://github.com/wei18/Sudoku**（自前 fixture の代替）。

- **確定的層 → ユニットテスト（TDD）**：Discovery の分類、Consolidate の重複排除・ソート、HTML/issue の組み立て。LLM には触れない。
- **LLM 層 → コントラクトテスト**：サブエージェントの出力が **findings スキーマに準拠していること**を検証する（フィールドの網羅性、severity/confidence/ssot_direction が合法な値域内にあること）。内容を逐一アサートしない。
  - CI：**録音済みのフェイクレスポンス**を使用してスキーマコントラクトテストを実施（コスト節約・安定性向上）。
  - 実際の API への接続：手動 / リリース前スモークテストのみ。
- **エンドツーエンドスモーク**：Sudoku リポジトリに対してアクション全体を実行し、HTML/issue の存在、findings のスキーマ準拠、妥当な数量の問題検出をアサートする（逐一アサートしない）。

---

## 11. スコープ境界（第一版では実装しない）

- 自動修正 PR（README の自動更新、孤立ファイルの自動削除）——第二版に持ち越し
- 動的なカスタム reviewer——i18n の組み込みで対応済み
- PR 差分モード——フルスキャンを主とする
- SSOT 宣言ファイル——純粋な推論方式に変更
