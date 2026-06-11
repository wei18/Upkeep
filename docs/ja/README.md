<p align="center">
  <img src="../assets/banner.svg" alt="Upkeep — your AI writes fast, Upkeep keeps it honest" width="100%">
</p>

# Upkeep

[English](../../README.md) · [繁體中文](../zh-TW/README.md) · [简体中文](../zh-CN/README.md) · **日本語** · [한국어](../ko/README.md)

**skill としてインストールする、あなたのリポジトリのための AI 監査チームです。** Upkeep は専任の AI レビュアーを並列で実行してドリフト——陳腐化したドキュメント、コードと一致しなくなった仕様、孤立アセット、破られた規約——を検出し、蓄積する前に証拠を添えて報告します。

> 💳 **追加の API 請求は発生しません。** Upkeep は既存の **Claude Pro/Max サブスクリプション**で動作します——ローカルではログイン済みの `claude` CLI、CI では `claude setup-token` による OAuth を使用します。Anthropic API キー不要、トークン課金なし。さらに**出力のみ**で、ドリフトを根拠と重大度を添えて報告しますが、ファイルを編集・削除することは一切ありません。

## インストール

**Claude Code** — plugin としてインストールします：

```
/plugin marketplace add wei18/upkeep
/plugin install upkeep@upkeep
```

**その他のエージェント**（Cursor、Copilot、および [skills](https://github.com/vercel-labs/skills) がサポートする 70 以上のエージェント）：

```bash
npx skills add wei18/upkeep --skill upkeep-audit
```

**要件**：ログイン済みの `claude` CLI（Pro/Max）、Node 20+、git——どのインストール方法でも、エンジンはあなたのマシン上で実行されます。

その後、任意のセッションで次のように依頼します：

> Run an upkeep audit on /path/to/repo

初回実行時、skill は Upkeep エンジンを `~/.cache/upkeep` に自動で clone し、依存関係をインストールします。チャットで重大度ごとにグループ化された検出結果が得られ、加えて独立した HTML レポートも生成されます。

## 概要

- リポジトリをスキャンし、**専任 AI レビュアーチーム**を並列で実行します。
- コードから乖離した陳腐化ドキュメント、実装と一致しなくなった仕様、重複・孤立ファイル、規約違反、翻訳ドキュメントの同期ずれを検出します。
- **証拠を添えて乖離を報告**します — いずれかのアーティファクトが常に正解とは判断しません。
- **ファイルの編集・削除は一切行いません** — 出力のみです。
- 独立した **HTML レポート**を生成します——CI で実行した場合は、**永続的な GitHub トラッキング issue**（upsert 方式、重複なし）も生成されます。

## 他ツールとの違い

Upkeep は linter でも PR bot でもなく、**リポジトリ全体を対象とした意味的ドリフト監査ツール**です。役割が異なります：

| | **Upkeep** | Danger | Copilot / Cursor PR review |
|---|---|---|---|
| 対象 | **リポジトリ全体**——ドキュメント・仕様・アセット・規約 | PR の diff | PR の diff |
| 検出するもの | **意味的ドリフト**（README は X と書くがコードは Y） | **自分で書く**ルール違反 | diff 内のコード問題 |
| 基準 | リポジトリ**自身の**規約 | 自作ルール | 一般的なコード知識 |
| 実行頻度 | スケジュール／オンデマンド、リポジトリ全体 | PR ごと | PR ごと |
| コードを編集する？ | **しない**——出力のみ | しない | 変更を提案 |
| コスト | あなたの **Claude Pro/Max** プラン | 無料（ロジックは自作） | Copilot/Cursor のサブスク |

## スクリプトで実行

エージェントを一切使わない場合は？同じパイプラインをスタンドアロンのスクリプトとして実行できます：

```bash
git clone --depth 1 https://github.com/wei18/upkeep ~/.cache/upkeep
cd ~/.cache/upkeep && npm ci
./scripts/local-audit.sh /path/to/repo --out ~/upkeep-report.html
```

| フラグ | デフォルト | 対応する CI input |
|---|---|---|
| `--model` | `claude-opus-4-8` | `model` |
| `--rubric-lang` | `en` | `rubric_lang` |
| `--max-turns` | `30` | `max_turns` |
| `--out` | `./upkeep-report.html` | report artifact |

**要件**：ログイン済みの `claude` CLI（Pro/Max サブスクリプション。`setup-token` も GitHub アクセスも不要）、Node 20+、git。

**出力**：同じ独立した HTML レポート（デフォルトでは `upkeep-report.html`）とターミナルサマリー。ローカル実行では GitHub issue は作成されません。

skill を手動でインストールしたい場合は、[`skills/upkeep-audit/`](../../skills/upkeep-audit/) を `~/.claude/skills/` にコピーしてください。

## CI で自動化

同じ監査チームを、スケジュールで実行します。リポジトリに `.github/workflows/audit.yml` を作成します。

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
    uses: wei18/upkeep/.github/workflows/audit.yml@v2
    with:
      model: claude-opus-4-8     # optional
      issue_label: audit         # optional; default: audit
      rubric_lang: en            # optional; reviewer language: en | zh-TW
    secrets:
      claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

**前提条件**

- `CLAUDE_CODE_OAUTH_TOKEN` という名前のリポジトリ secret。ローカルで `claude setup-token` を実行して生成してください（Claude Pro/Max サブスクリプションが必要で、使用量はサブスクリプションに計上されます）。
- 上記の `permissions` ブロック（`contents: read` + `issues: write` + `id-token: write`）。

**出力**

- `audit` ラベル付きの GitHub issue — 毎回同じ issue が更新（upsert）され、重複は作成されません。
- `report-html` workflow artifact としてアップロードされる独立した HTML レポート。トラッキング issue から直接リンクされます。それ以外では、その run の **Artifacts**（Actions → 該当 run）から、または `gh run download <run-id> -n report-html` で取得できます。GitHub の artifact はダウンロード可能な zip で、リポジトリの保持設定に従って期限切れになります。

> まだ `@v1` をお使いですか？引き続き動作しますが凍結されています——タグを `@v2` に切り替えてください。インターフェースは同一です。

## レビュアー

| 名前 | デフォルト | チェック内容 |
|---|---|---|
| `docs_staleness` | 有効 | コードから乖離したドキュメント、ベース言語と同期が取れていない多言語 README・翻訳ドキュメント |
| `code_hygiene` | 有効 | デッドコード、未使用エクスポート、永続的にコメントアウトされたブロック |
| `spec_flow` | 有効 | 実装と一致しなくなった仕様・ダイアグラム・フローチャート |
| `visual_icon` | 有効 | 古くなった・不一致な画像やアイコン |
| `duplicate_orphan` | 有効 | 重複ファイルおよび参照されていない孤立アセット |
| `convention` | 有効 | リポジトリ独自の規約違反（CLAUDE.md、`.claude/skills`、workflow） |
| `i18n` | **無効** | ロケールファイル間の国際化の整合性 |

## 設定

設定は意図的に 2 つの独立した面に分かれています:

- **Workflow 入力**（上記の呼び出し元の `with:` ブロック。ローカルでは対応するスクリプトのフラグ）は*エンジンの動かし方*を制御します: `model`、`max_turns`、`issue_label`、`rubric_lang`。
- **`.claude/audit.yml`**（監査対象の repo にコミット）は*何を監査するか*を制御します: どのレビュアーを有効にするか、per-reviewer の rubric 上書き、`report.minSeverity`。レビュアーの有効・無効はここに置かれます——workflow 入力ではなく——repo ごとに、repo とともに進化すべきポリシーだからです。

設定はすべて任意です。たとえばデフォルトで無効な `i18n` レビュアーを有効にするには:

```yaml
# .claude/audit.yml
reviewers:
  i18n:
    enabled: true
```

スキーマとオプションの詳細は [`docs/design.md`](design.md) を参照してください。

## ドキュメント

- [`docs/overview.md`](overview.md) — パイプラインの動作説明
- [`docs/design.md`](design.md) — 設計リファレンス（フル版）
- [`docs/why-reusable-workflow.md`](why-reusable-workflow.md) — なぜ CI レイヤーが step アクションではなく reusable workflow なのか
