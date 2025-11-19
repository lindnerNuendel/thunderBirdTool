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
    

    // 7) Move both messages into "Rejected" folder
    const rejectedFolder = await findRejectedFolder();
    if (rejectedFolder) {
      await browser.messages.move(
        [bossMsgHeader.id],
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
// 3.4 Find "Rejected" folder
// ======================================================================

async function findRejectedFolder() {
  const accounts = await browser.accounts.list();
  for (const account of accounts) {
    const folder = findFolderByName(account.folders, "abgesagt", null);
    if (folder) return folder;
  }
  return null;
}

function findFolderByName(folders, name, parentFolderName) {
  if (!folders) return null;
  for (const f of folders) {
    // Check if current folder matches the target name
    if (f.name === name) {
      // Check if parent folder's name starts with "Bewerber"
      if (parentFolderName && parentFolderName.startsWith("Bewerber")) {
        return f;
      }
    }
    // Recurse into subfolders, passing current folder's name as parent
    const sub = findFolderByName(f.subFolders, name, f.name);
    if (sub) return sub;
  }
  return null;
}