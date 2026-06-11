# なぜ Upkeep は再利用可能ワークフロー（step action ではない）なのか

ほとんどの GitHub Actions は **step** として使われます：

```yaml
steps:
  - uses: actions/checkout@v4
```

Upkeep は **job** として、ワークフローファイルを指す形で使われます：

```yaml
jobs:
  audit:
    uses: wei18/upkeep/.github/workflows/audit.yml@v2
```

この 2 つ目の書き方は、よく見る `- uses: owner/action@v1` と並べると見慣れず、なぜかと尋ねられます。これは **再利用可能ワークフロー**（`on: workflow_call`）の標準的で公式ドキュメントに記載された構文です——[GitHub: Reuse workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows) を参照。以下に Upkeep がそう設計されている理由を説明します。

## 理由：並列で障害隔離された reviewer には `strategy.matrix` が必要

Upkeep は reviewer のチームをディスパッチします。各 reviewer には次を求めます：

- **並列**で実行されること——完全な監査が単一 reviewer の実時間の 6 倍かかってはならない。そして
- **障害隔離**されていること——ある reviewer の失敗（タイムアウト、API の不調）が他を中断させてはならない。

「同じユニットを並列かつ独立に何度も実行する」ための GitHub ネイティブのプリミティブが `strategy.matrix` です。**matrix は job レベルの機能**であり、job と matrix を宣言できるのは *workflow* だけで、*action* にはできません。reviewer を並列・隔離された複数の matrix job にファンアウトするには、Upkeep は再利用可能ワークフローでなければなりません。

## なぜ単に action として出さないのか？

action には 2 種類あり、どちらもこのファンアウトを表現できません：

- **JavaScript / Docker action**——単一のエントリポイント（例：`main: dist/index.js`）。他の action を `uses:` できないため、LLM 処理を [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action) に委譲できず、自前で Claude を呼ぶ必要があります。さらに job を並列実行することもできません。
- **Composite action**——**1 つ**の job 内の *step* のシーケンスとして実行されます。他の action を `uses:` *できる*（よって `claude-code-action` を呼べる）ものの、matrix がないため reviewer は単一 job 内で**逐次**実行されます。

つまり composite action（`- uses: wei18/upkeep@v2`）も *可能* です——reviewer が逐次になる代償付きで。Upkeep は reviewer を並列かつ各自隔離に保つため、あえて再利用可能ワークフローの形を選びました。スケジュール監査なら遅い逐次パスでも許容できますが、私たちは並列性とクリーンな障害隔離を優先しました。

## 実際に手放すもの

呼び出し側の構文だけです。`- uses: owner/action@ref` の代わりに `jobs.<id>.uses: owner/repo/.github/workflows/file.yml@ref` を使います。それ以外はすべて action と同じです：`with:` で inputs、`secrets:` で secrets、`@v1` でバージョン固定。
