# fabplane for Hermes Agent

A [Hermes Agent](https://github.com/NousResearch/hermes-agent) skill (Nous Research) that keeps a
team's parts inventory and shopping lists on fabplane.com and backfills missing part photos, through
the `fabplane` CLI. The agent works as a **bot member** of your org, never with a person's login.

The skill follows the Hermes `SKILL.md` format: YAML frontmatter with `name`, `description`
(kept under 60 characters) and `version`, optional `metadata.hermes` (`tags`, `category`,
`requires_toolsets`), then *When to Use / Quick Reference / Procedure / Pitfalls / Verification*
sections. Sources:
[Creating Skills](https://hermes-agent.nousresearch.com/docs/developer-guide/creating-skills),
[Skills System](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills).

## Setup

1. **Install the CLI** on the machine Hermes runs on (Node.js 20+). See the
   [main README](../../README.md#install); check with `fabplane version`.

2. **Connect the bot.** As the user Hermes runs as:

   ```sh
   fabplane bot connect --agent hermes --name "hermes on $(hostname)"
   ```

   It prints a link and a code (and opens the browser when it can). Add `--org <slug>` to suggest an
   org, and `--origin <url>` for an API other than fabplane.com.

3. **Approve the link.** An admin of the org opens the link, signs in to the fabplane dashboard, checks
   the code, picks the org and role (`member` is enough), and approves. The CLI stores the bot token and
   makes the bot's org the default; `fabplane whoami` then shows `kind: bot`.

   Headless alternative: an admin runs `fabplane bots create "hermes" --agent hermes` and you set the
   printed token as `FABPLANE_TOKEN` in the environment Hermes runs commands in.

4. **Install the skill.** Hermes loads local skills from `~/.hermes/skills/<category>/<skill-name>/SKILL.md`
   ([Skills System](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)):

   ```sh
   mkdir -p ~/.hermes/skills/productivity
   cp -r integrations/hermes/fabplane-inventory ~/.hermes/skills/productivity/
   hermes skills list          # should list fabplane-inventory
   ```

   Alternatively, add a checkout's `integrations/hermes` folder to `skills.external_dirs` in
   `~/.hermes/config.yaml`. Hermes documents `hermes skills install owner/repo/path` for GitHub paths;
   `hermes skills install fabPlane/fabplane-cli/integrations/hermes/fabplane-inventory` should
   therefore work, but it has **not been verified** against this repository, so copying the folder is the
   documented route. The skill needs the `terminal` toolset (it runs the `fabplane` CLI) and web
   search/browsing for the photo backfill.

   Invoke it with `/fabplane-inventory <request>`, or just talk about inventory.

5. **Optional: schedule the photo backfill.** Hermes cron jobs run in a fresh session, so the prompt names
   the skill and the task. `--deliver local` keeps the output in `~/.hermes/cron/output/`
   ([Scheduled Tasks (Cron)](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)):

   ```sh
   hermes cron create "every 24h" \
     "Do one pass of the Photo backfill procedure: claim 5 items, attach only photos you checked against the item, otherwise skip or retry with a reason." \
     --skill fabplane-inventory --name "fabplane photo backfill" --deliver local
   hermes cron list
   ```

   Scheduled jobs only fire while the Hermes gateway is running (`hermes gateway`, or install it as a
   service with `hermes gateway install`), per the same page. The docs show natural-language schedules
   like `"every 2h"`; check them for cron-expression syntax before relying on one.

## What the skill does

- **Inventory upkeep:** search before adding, stable `hermes:<slug>` external ids, fields extracted by the
  agent itself, photos via `--image`, never `--server-ai` (server-side AI is not available and returns 501).
- **Shopping lists:** carts per repo or project, items with purchase destinations, BOM import. It never
  places orders.
- **Photo backfill:** claim, find the product photo, check it matches, attach with the product page as the
  source, or skip with a reason.

To revoke access, an org admin removes the bot in the dashboard or with `fabplane bots remove <botId>`.
