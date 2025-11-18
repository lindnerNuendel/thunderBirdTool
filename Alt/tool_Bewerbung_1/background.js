// HR Reject Button - background.js

// Entry point: user clicks "Reject candidate" on a displayed message
browser.messageDisplayAction.onClicked.addListener(async (tab) => {
  try {
    // 1) Get currently displayed message
    const displayed = await browser.messageDisplay.getDisplayedMessage(tab.id);
    if (!displayed) {
      console.log("No message displayed.");
      return;
    }

    const bossMsgHeader = displayed;

    // 2) Load boss mail
    const bossFull = await browser.messages.getFull(bossMsgHeader.id);

    // 3) Locate original application mail
    const appHeader = await findOriginalApplication(bossMsgHeader, bossFull);
    if (!appHeader) {
      console.log("Could not locate original application message.");
      return;
    }

    // 4) Extract applicant info
    const appFull = await browser.messages.getFull(appHeader.id);
    const applicant = extractApplicantInfo(appHeader, appFull);

    // 5) Open clean new email (no quoting)
    const composeTab = await browser.compose.beginNew({});

    // 6) Fill rejection template
    await fillRejectionTemplate(composeTab.id, applicant, appHeader, appFull);

    // 7) Move both messages into "Rejected" folder
    const rejectedFolder = await findRejectedFolder();
    if (rejectedFolder) {
      await browser.messages.move(
        [bossMsgHeader.id, appHeader.id],
        rejectedFolder
      );
    } else {
      console.log('Could not find "Rejected" folder – skipping move.');
    }

  } catch (e) {
    console.error("Error in Reject Button:", e);
  }
});


// ======================================================================
// 3.1 Find original application message
// ======================================================================

async function findOriginalApplication(bossHeader, bossFull) {
  // Attempt: references / in-reply-to
  const refs = bossFull.headers["references"] || bossFull.headers["in-reply-to"];
  if (refs && refs.length > 0) {
    const headerMsgId = refs[0];
    const list = await browser.messages.query({
      headerMessageId: headerMsgId.trim()
    });
    if (list.messages && list.messages.length > 0) {
      return list.messages[0];
    }
  }

  // Fallback: subject match
  const cleanSubject = stripFwRe(bossHeader.subject || "");
  const sameFolderList = await browser.messages.list(bossHeader.folder);

  for await (const page of getMessagePages(sameFolderList)) {
    const candidate = page.messages.find(
      m => stripFwRe(m.subject || "") === cleanSubject && m.id !== bossHeader.id
    );
    if (candidate) return candidate;
  }

  return null;
}

async function* getMessagePages(firstPagePromise) {
  let page = await firstPagePromise;
  yield page;

  while (page.id) {
    page = await browser.messages.continueList(page.id);
    yield page;
  }
}

function stripFwRe(subject) {
  return subject.replace(/^\s*((re|fw|fwd|wg|aw):\s*)+/i, "").trim();
}


// ======================================================================
// 3.2 Extract applicant info
// ======================================================================

function extractApplicantInfo(appHeader, appFull) {
  const fromRaw = (appFull.headers.from && appFull.headers.from[0]) || appHeader.author || "";
  const { name, email } = parseNameEmail(fromRaw);

  const bodyText = getPlainBody(appFull);

  const betterName = tryGuessNameFromBody(name, bodyText);
  const jobPosition = extractJobPosition(bodyText);

  return {
    name: betterName || name || "Applicant",
    email: email,
    position: jobPosition || null
  };
}


// --- Job Position Parser ---
function extractJobPosition(body) {
  if (!body) return null;

  body = body.replace(/\s+/g, " ").trim();

  const patterns = [
    /bewerbung\s+als\s+([^.,\n]+)/i,
    /bewerbung\s+um\s+die\s+stelle\s+als\s+([^.,\n]+)/i,
    /bewerbung\s+um\s+die\s+stelle\s+([^.,\n]+)/i,
    /ich\s+bewerbe\s+mich\s+als\s+([^.,\n]+)/i,
    /ich\s+bewerbe\s+mich\s+für\s+die\s+position\s+([^.,\n]+)/i,
    /hiermit\s+bewerbe\s+ich\s+mich\s+als\s+([^.,\n]+)/i,
    /hiermit\s+bewerbe\s+ich\s+mich\s+für\s+die\s+position\s+([^.,\n]+)/i,
    /meine\s+bewerbung\s+als\s+([^.,\n]+)/i,

    // English
    /I\s+am\s+applying\s+for\s+the\s+position\s+of\s+([^.,\n]+)/i,
    /application\s+for\s+the\s+position\s+of\s+([^.,\n]+)/i
  ];

  for (const regex of patterns) {
    const m = body.match(regex);
    if (m && m[1]) return m[1].trim();
  }

  return null;
}


// --- Parse name + email ---
function parseNameEmail(fromHeader) {
  const emailMatch = fromHeader.match(/<([^>]+)>/);
  let email = null;
  let name = null;

  if (emailMatch) {
    email = emailMatch[1].trim();
    name = fromHeader.replace(emailMatch[0], "").replace(/"/g, "").trim();
  } else {
    const simpleEmail = fromHeader.match(/[^@\s]+@[^@\s]+/);
    if (simpleEmail) {
      email = simpleEmail[0];
      name = fromHeader.replace(simpleEmail[0], "").replace(/["<>]/g, "").trim();
    }
  }

  if (!name && email) {
    const local = email.split("@")[0];
    name = local.replace(/[._-]+/g, " ")
                .split(" ")
                .map(w => w.charAt(0).toUpperCase() + w.slice(1))
                .join(" ");
  }

  return { name, email };
}


// --- Extract plain-body ---
function getPlainBody(part) {
  if (!part) return "";
  if (part.body) return part.body;

  if (part.parts && part.parts.length) {
    for (const p of part.parts) {
      const text = getPlainBody(p);
      if (text) return text;
    }
  }

  return "";
}


// --- Improve name based on salutation ---
function tryGuessNameFromBody(currentName, body) {
  if (!body) return currentName;

  const lines = body.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  // --- 1) Detect generic salutation (ignore these) ---
  const genericSalutations = [
    /^sehr\s+geehrte\s+damen\s+und\s+herren,?$/i
  ];

  for (const line of lines.slice(0, 5)) {
    if (genericSalutations.some(re => re.test(line))) {
      // ignore this salutation completely
      break;
    }
  }

  // --- 2) Detect personalized salutation ---
  const salutationPatterns = [
    /^sehr\s+geehrte[rn]*\s+(.+?),?$/i,
    /^dear\s+(.+?),?$/i,
    /^hello\s+(.+?),?$/i,
    /^hi\s+(.+?),?$/i,
    /^hallo\s+(.+?),?$/i
  ];

  for (const line of lines.slice(0, 10)) {
    for (const re of salutationPatterns) {
      const m = line.match(re);
      if (m && m[1]) {
        let name = m[1].trim();

        // Reject generic terms mistakenly extracted as names
        if (/damen\s+und\s+herren/i.test(name)) continue;

        name = name.split(/\s+/)
                   .map(w => w.charAt(0).toUpperCase() + w.slice(1))
                   .join(" ");
        return name;
      }
    }
  }

  // --- 3) Extract name from signature ---
  // Typical lines at the end:
  // "Mit freundlichen Grüßen"
  // "Max Mustermann"
 const signatureIndex = lines.findIndex(l =>
  /^(mit\s+freundlichen\s+grüßen|mit\s+freundlichem\s+gruß|freundliche\s+grüße|freundlichen\s+gruß|liebe\s+grüße|beste\s+grüße|viele\s+grüße|herzliche\s+grüße|hochachtungsvoll|schöne\s+grüße|besten\s+gruß|kind\s+regards|best\s+regards|sincerely|yours\s+sincerely|yours\s+faithfully|regards|best\s+wishes)$/i.test(l)
);

  if (signatureIndex !== -1 && lines[signatureIndex + 1]) {
    const nameLine = lines[signatureIndex + 1].trim();
    if (nameLine.split(" ").length <= 4) { // simple sanity check
      const name = nameLine.split(/\s+/)
                           .map(w => w.charAt(0).toUpperCase() + w.slice(1))
                           .join(" ");
      return name;
    }
  }

  return currentName;
}



// ======================================================================
// 3.3 Fill the rejection template
// ======================================================================

async function fillRejectionTemplate(composeTabId, applicant, appHeader, appFull) {

  const name = applicant.name || "Applicant";

  const receivedDate = new Date(appHeader.date).toLocaleDateString();
  const originalSubject = stripFwRe(appHeader.subject || "your application");

  let positionText = "";
  if (applicant.position) {
    positionText = ` regarding the position "${applicant.position}"`;
  }

  const templateText = `
Hallo ${name},

wir beziehen uns auf Ihre Bewerbung ${positionText} vom ${receivedDate} und bedanken uns für Ihr Interesse an einer Mitarbeit in unserem Hause.

Nach interner Prüfung Ihrer Unterlagen sind wir zu dem Ergebnis gekommen, Ihre Bewerbung nicht in die engere Auswahl mit einzubeziehen.

Es tut uns leid, dass wir Ihnen keine positive Nachricht geben konnten. 

Für Ihre weitere Suche nach der passenden Stelle wünschen wir Ihnen den erhofften Erfolg.
Freundliche Grüße,
[ABSENDER]

`.trim();

  const subject = "Re: " + originalSubject;

  // Wait for compose window to load
  await new Promise(r => setTimeout(r, 150));

  await browser.compose.setComposeDetails(composeTabId, {
    to: [applicant.email],
    subject: subject,
    body: templateText.replace(/\n/g, "<br>"),
    plainTextBody: templateText
  });
}


// ======================================================================
// 3.4 Find "Rejected" folder
// ======================================================================

async function findRejectedFolder() {
  const accounts = await browser.accounts.list();
  for (const account of accounts) {
    const folder = findFolderByName(account.folders, "Pool");
    if (folder) return folder;
  }
  return null;
}

function findFolderByName(folders, name) {
  if (!folders) return null;
  for (const f of folders) {
    if (f.name === name) return f;
    const sub = findFolderByName(f.subFolders, name);
    if (sub) return sub;
  }
  return null;
}
