// Registers the demo people on the Nexus dev homeserver (idempotent), with the same
// usernames as their portal accounts, so @demo-avery:chatdev.test matches the portal user.
import { devServerInfo, registerUser } from "../../tests/chat/lib/synapse.mjs";

const PEOPLE = [
  ["demo-avery", "Avery Example"], ["demo-morgan", "Morgan Sample"], ["demo-riley", "Riley Placeholder"],
  ["demo-jordan", "Jordan Fictional"], ["demo-casey", "Casey Testcase"], ["demo-sam", "Sam Mockwell"],
];
const info = devServerInfo();
const password = process.env.NEXUS_DEMO_PASSWORD;
if (!password) throw new Error("NEXUS_DEMO_PASSWORD is not set (source dev/nexus/env.sh)");
for (const [username, displayname] of PEOPLE) {
  try {
    await registerUser(info, { username, password, displayname });
    console.log(`matrix: registered @${username}:${info.serverName}`);
  } catch (e) {
    if (/M_USER_IN_USE|already taken/.test(String(e))) console.log(`matrix: @${username}:${info.serverName} exists`);
    else throw e;
  }
}
