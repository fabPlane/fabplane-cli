# fabplane for openclaw

An openclaw skill that keeps a team's parts inventory and shopping lists on fabplane.com and
backfills missing part photos, through the `fabplane` CLI. The agent works as a **bot member** of
your org, never with a person's login.

## Setup

1. **Install the CLI** on the machine openclaw runs on (Node.js 20+). See the
   [main README](../../README.md#install); check with `fabplane version`.

2. **Connect the bot.** As the user openclaw runs as:

   ```sh
   fabplane bot connect --agent openclaw --name "openclaw on $(hostname)"
   ```

   It prints a link and a code (and opens the browser when it can). Add `--org <slug>` to suggest an
   org, and `--origin <url>` for an API other than fabplane.com.

3. **Approve the link.** An admin of the org opens the link, signs in to the fabplane dashboard, checks
   the code, picks the org and role (`member` is enough for inventory, carts and the photo queue), and
   approves. The CLI stores the bot token in its credentials file and makes the bot's org the default.
   `fabplane whoami` then shows `kind: bot`.

   For a headless machine, an admin can instead run `fabplane bots create "openclaw" --agent openclaw`
   elsewhere and set the printed token as `FABPLANE_TOKEN` for openclaw (or run
   `fabplane login --token <token>` on the machine).

4. **Install the skill.** Copy the folder into openclaw's workspace skills:

   ```sh
   mkdir -p ~/.openclaw/workspace/skills
   cp -r integrations/openclaw/fabplane-inventory ~/.openclaw/workspace/skills/
   # from an npm install: cp -r "$(npm root -g)/fabplane-cli/integrations/openclaw/fabplane-inventory" ~/.openclaw/workspace/skills/
   ```

   The skill is user-invocable (`/fabplane-inventory …`) and is also picked up when inventory comes up.

5. **Optional: schedule the photo backfill.** A nightly isolated run, with output kept internal. The
   declaration key makes re-running the command update the job instead of adding a second one:

   ```sh
   openclaw cron add --name "fabplane photo backfill" --cron "0 3 * * *" \
     --session isolated --light-context --no-deliver \
     --declaration-key fabplane-photo-backfill \
     --message "Use the fabplane-inventory skill and do one pass of its Photo backfill section: claim 5 items, attach only photos you checked against the item, otherwise skip or retry with a reason."
   ```

   See the [openclaw cron docs](https://docs.openclaw.ai/cli/cron) for schedules (`--every`, `--tz`) and
   for listing or removing jobs.

## What the skill does

- **Inventory upkeep:** search before adding, stable `openclaw:<slug>` external ids so retries update
  instead of duplicating, fields extracted by the agent itself (`--attr key=value` for the rest), photos
  via `--image`, never `--server-ai` (server-side AI is not available and returns 501).
- **Shopping lists:** carts per repo or project, items with purchase destinations, BOM CSV import and
  export. It never places orders.
- **Photo backfill:** claim items from the queue, find the product photo, look at it and check it
  matches, attach it with the product page as the source, or skip with a reason.

To revoke access, an org admin removes the bot in the dashboard or with `fabplane bots remove <botId>`.
