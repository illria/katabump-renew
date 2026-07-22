# Katabump Server Auto-Renewal Tool

[English Version](README_EN.md) | [中文说明](README.md)

This project is an automation script for renewing Katabump servers with Playwright. It launches a browser with native proxy settings, processes each configured account in an isolated BrowserContext, and records explicit business outcomes.

It is designed for **GitHub Actions on Ubuntu/Linux**.

## ✨ Features

- **Explicit outcomes**: Separates target responses, proxy authentication failures, gateway failures, transport failures, and account failures.
- **Account isolation**: One invalid account is recorded as a login failure while later valid accounts continue.
- **Multi-User**: Supports batch renewal for multiple accounts.
- **Cloud/Local**: Can run on your local machine or automatically on a daily schedule using GitHub Actions.

---

## 🚀 GitHub Actions Cloud Run (Recommended)

This is the easiest way to set it up once and have it run automatically every day.

1.  **Fork this repository** to your GitHub account.
2.  Go to your repository settings: **Settings** -> **Secrets and variables** -> **Actions**.
3.  Click **New repository secret** and add a secret named `USERS_JSON`.
4.  The **Value** must be a JSON array (condensed into a single line is best):
    ```json
    [{"username": "your_email@example.com", "password": "your_password"}, {"username": "another@example.com", "password": "pwd"}]
    ```
5.  **(Optional) Configure Proxy**:
    If you need to run behind a proxy (e.g. to avoid IP blocks), add a Secret named `HTTP_PROXY`.
    -   **Supported proxy line formats**:
        -   `HOST:PORT`
        -   `HOST:PORT:USERNAME:PASSWORD`
        -   `http://USERNAME:PASSWORD@HOST:PORT`
    -   **Note**: Ports must be decimal values from 1 to 65535. Paths, query strings, fragments, extra fields, and unsafe host characters are rejected. Lines without `http://` are parsed only as the Webshare format.
    -   **Note**: The script validates the proxy before use. Default is disabled.
6.  **(Optional) Telegram Notifications**:
    If you want to receive Telegram notifications (with screenshots) upon renewal success, failure, or skip, add the following Secrets:
    -   `TG_BOT_TOKEN`: Your Telegram Bot Token (from @BotFather).
    -   `TG_CHAT_ID`: Your Chat ID (User ID or Group ID).
    > If not configured, notifications will be skipped.
### 4. Results & Screenshots
- **Logs**: Check real-time logs in the `Run Renew Script` step.
- **Screenshots**: Screenshots are automatically captured for each user (success or failure), sent with configured Telegram notifications, and uploaded as artifacts.
  - Download the `screenshots` zip file from the **Artifacts** section of the workflow run summary.
  - Files are named `username.png`.
5.  Save it. Then, go to the **Actions** tab and enable the workflow. It is scheduled to run automatically at **08:00 Beijing Time (00:00 UTC)**.
6.  You can also manually click "Run workflow" to test it immediately.

### Runtime behavior

- The proxy list is downloaded, parsed and filtered, then an uncooldown proxy is selected and preflighted against the target login URL before Playwright starts.
- Preflight categories are `target_reachable`, `target_server_error`, `proxy_auth_failed`, `upstream_gateway_error`, and `transport_error`.
- The default child-process timeout is 25 minutes. `ACTION_TIMEOUT_MINUTES` may adjust it, but it must remain below the 30-minute workflow timeout.
- A timeout first sends SIGTERM to the process group, waits 12 seconds for cleanup, and then sends SIGKILL if needed. Image-upload failures are logged without changing the renewal result.

---

## 🐧 Linux GitHub Actions Runtime

The workflow is the only supported runtime: Ubuntu, Node.js 24, Xvfb, and the Chrome installation prepared by the Playwright dependency step. It runs `npm ci`, preflights the target login URL through the selected proxy, starts Playwright with native proxy settings, processes accounts in order, and uploads screenshots as artifacts.

---

## 🛠️ Project Structure

*   `action_renew.js`: Dedicated script for GitHub Actions environment (Linux/Headless adapted).
*   `proxy_runner.js`: Proxy selection, cooldown, child-process timeout, and exit-code controller.
*   `.github/workflows/renew.yml`: Configuration file for GitHub Actions scheduled tasks.
