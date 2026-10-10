# Redmine Workspace

Redmine Workspace is a self-hosted, desktop-first web client for managing Redmine issues on a kanban board. It brings project work, releases, backlog items, issue activity, and notifications into one local app.

The app is built with TypeScript, React, Fastify, and SQLite. Docker Compose is the easiest way to run it. The interface supports English, Ukrainian, Polish, and Spanish.

## Features

- Kanban board with project, assignee, watched, and backlog filters, plus saved filters and sorting.
- Issue details for status, priority, assignee, labels, roles, comments, and activity.
- Release views that keep workflow status separate from version membership.
- Inbox with unread activity and per-project activity filters.
- Local preferences, keyboard shortcuts, and drafts.
- Isolated demo mode, Redmine read-only mode, and an explicit opt-in for supported writes to Redmine.

## Quick start

You need Docker with the Docker Compose plugin. From the repository root, run:

~~~sh
cp .env.example .env
docker compose up --build -d
~~~

If you already have a local .env file, edit it instead of copying over it. With the default configuration, no API token is set and APP_MODE is auto, so the app starts with isolated demo data. No Redmine account is needed to try the demo.

Open [http://127.0.0.1:3010](http://127.0.0.1:3010).

Useful commands:

~~~sh
docker compose logs -f app
docker compose down
~~~

The SQLite database is stored in the persistent workspace-data Docker volume. Stopping the app with docker compose down keeps your data. To remove the database as well, use docker compose down --volumes.

## Connect to Redmine

Edit the local .env file and set your Redmine URL and API token:

~~~dotenv
APP_MODE=auto
REDMINE_URL=https://redmine.example.invalid
REDMINE_API_TOKEN=replace-with-your-api-token
REDMINE_WRITE_ENABLED=false
~~~

Replace the example URL and token with values for your Redmine instance. In auto mode, an empty token starts the demo and a configured token selects Redmine. You can set APP_MODE=redmine to explicitly select Redmine or APP_MODE=demo to keep using the demo.

The app is read-only by default, even when connected to Redmine. To allow supported user actions to write to Redmine, set REDMINE_WRITE_ENABLED=true. This sends those actions to your Redmine instance; leave it false if you only want to browse. The API token is used by the backend and is not sent to the browser.

If your CI automation uses different label names, set REDMINE_CI_IN_PROGRESS_LABEL and REDMINE_CI_FAILED_LABEL in .env. Project, status, custom-field, and option IDs are discovered from Redmine; they do not need to be copied into configuration.

Recreate the container after changing environment variables:

~~~sh
docker compose up -d --force-recreate app
~~~

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| APP_MODE | auto | Use demo when no token is set and Redmine when a token is set. Can also be set to demo or redmine. |
| REDMINE_URL | https://redmine.example.invalid | Base URL of your Redmine instance. |
| REDMINE_API_TOKEN | empty | Redmine API token used by the backend. |
| REDMINE_WRITE_ENABLED | false | Enables supported writes to Redmine only when APP_MODE selects Redmine. |
| REDMINE_CI_IN_PROGRESS_LABEL | Build: Running | Label that marks a CI job as in progress. |
| REDMINE_CI_FAILED_LABEL | Build: Failed | Label that marks a CI job as failed. |
| HOST_PORT | 3010 | Local port used to open the app. |
| POLL_INTERVAL_SECONDS | 10 | Background sync interval, in seconds. |

The Compose configuration binds the app to 127.0.0.1 by default. The .env file is excluded from Git and the Docker build context; do not commit it or paste its contents into logs or support requests.

## Run without Docker

Use Node.js 24, the version used by the Docker image. From the repository root:

~~~sh
npm ci
APP_MODE=demo npm run dev
~~~

Open the UI at [http://127.0.0.1:5173](http://127.0.0.1:5173). The development server runs the API on port 3000. The local SQLite database defaults to data/workspace.sqlite.

Common project commands:

~~~sh
npm run typecheck
npm test
npm run build
npm run test:e2e
~~~

## Notes and limitations

- In Redmine mode, the app uses the projects and data available to the configured API token. Redmine permissions and workflow rules still apply.
- Creating and editing issues, changing status, posting comments, and release actions can write to Redmine only when write mode is explicitly enabled and the action is supported by the instance.
- Editing or deleting existing comments and shared comment likes are not available for real Redmine instances.
- Demo mutations affect only local demo data. A Redmine connection failure is shown as an error and does not switch the app to demo mode.
- Browser preferences and drafts are stored locally; server-side settings, notifications, operations, and cached Redmine data are stored in SQLite.
