# Upkeep

[English](../../README.md) · [繁體中文](../zh-TW/README.md) · [简体中文](../zh-CN/README.md) · **日本語** · [한국어](../ko/README.md)

リポジトリのドキュメント・仕様・アセットの整合性を維持するための再利用可能な GitHub Actions workflow です。ドリフトが蓄積する前に検出します。

## 概要

- リポジトリをスキャンし、Anthropic の `claude-code-action` を活用した**専任 AI レビュアーチーム**を並列で実行します。
- コードから乖離した陳腐化ドキュメント、実装と一致しなくなった仕様、重複・孤立ファイル、規約違反、翻訳ドキュメントの同期ずれを検出します。
- **証拠を添えて乖離を報告**します — いずれかのアーティファクトが常に正解とは判断しません。
- **ファイルの編集・削除は一切行いません** — 出力のみです。
- 独立した **HTML レポート**（workflow artifact）と**永続的な GitHub トラッキング issue**（upsert 方式、重複なし）を生成します。

## 使い方

リポジトリに `.github/workflows/audit.yml` を作成します。

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
      rubric_lang: en            # optional; reviewer language: en | zh-TW
    secrets:
      claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

**前提条件**

- `CLAUDE_CODE_OAUTH_TOKEN` という名前のリポジトリ secret。ローカルで `claude setup-token` を実行して生成してください（Claude Pro/Max サブスクリプションが必要で、使用量はサブスクリプションに計上されます）。
- 上記の `permissions` ブロック（`contents: read` + `issues: write` + `id-token: write`）。

**出力**

- `audit` ラベル付きの GitHub issue — 毎回同じ issue が更新（upsert）され、重複は作成されません。
- `report-html` workflow artifact としてアップロードされる独立した HTML レポート。

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

- **Workflow 入力**（上記の呼び出し元の `with:` ブロック）は*エンジンの動かし方*を制御します: `model`、`max_turns`、`issue_label`、`rubric_lang`。
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
- [`docs/why-reusable-workflow.md`](why-reusable-workflow.md) — なぜ step アクションではなく reusable workflow なのか
