/**
 * HireCraft background service worker — the only place that talks to the API.
 *
 * Two reasons it lives here rather than in the content script. The key never
 * enters the employer's page, so a hostile or compromised careers site can't
 * read it. And MV3 content scripts are subject to CORS while the service worker
 * is not, for hosts in `host_permissions` — so this is also the only place the
 * request would succeed.
 */

const DEFAULT_API = "http://localhost:8000";

async function config() {
  const { apiUrl, extensionKey } = await chrome.storage.local.get([
    "apiUrl",
    "extensionKey",
  ]);
  return {
    api: (apiUrl || DEFAULT_API).replace(/\/$/, ""),
    key: extensionKey || "",
  };
}

/** Call the API with the stored key. Throws with a readable message. */
async function callApi(path, { method = "GET", body } = {}) {
  const { api, key } = await config();
  if (!key) throw new Error("Not connected — paste your key in the HireCraft popup.");

  let response;
  try {
    response = await fetch(`${api}/api/v1${path}`, {
      method,
      headers: {
        "X-HireCraft-Key": key,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // A DNS/connection failure and a 500 are different problems for the user:
    // one means HireCraft isn't running, the other means it is and something
    // went wrong inside it.
    throw new Error(`Couldn't reach HireCraft at ${api}. Is it running?`);
  }

  if (response.status === 401) {
    throw new Error("That key was rejected. Create a new one in Settings → Extension.");
  }
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.json()).detail || "";
    } catch {
      /* a non-JSON error body is not worth a second failure */
    }
    throw new Error(detail || `HireCraft returned ${response.status}.`);
  }
  return response;
}

/**
 * The résumé PDF, as a data URL.
 *
 * A content script can't be handed a File across the message boundary — the
 * structured clone drops it — so the bytes travel as a string and the page side
 * rebuilds the File.
 */
async function resumeDataUrl(resumeId) {
  const response = await callApi(`/extension/resume/${resumeId}.pdf`);
  const blob = await response.blob();
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read the résumé PDF."));
    reader.readAsDataURL(blob);
  });
  return dataUrl;
}

const HANDLERS = {
  async ping() {
    const profile = await (await callApi("/extension/profile")).json();
    return { ok: true, profile };
  },
  async profile() {
    return (await callApi("/extension/profile")).json();
  },
  async resume({ resumeId }) {
    return { dataUrl: await resumeDataUrl(resumeId) };
  },
  async track({ url, resumeId }) {
    const body = { job: { url }, tailor: false };
    if (resumeId) body.resume_profile_id = resumeId;
    return (await callApi("/extension/track", { method: "POST", body })).json();
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = HANDLERS[message?.type];
  if (!handler) return false;
  // Errors are returned rather than thrown: an exception here surfaces to the
  // caller as a bare "message port closed", which tells the user nothing.
  handler(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
  return true; // keep the port open for the async reply
});
