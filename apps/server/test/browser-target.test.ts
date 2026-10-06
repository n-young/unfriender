import test from "node:test";
import assert from "node:assert/strict";
import { normalizedNameTokens, targetNameMatches } from "../src/adapters/browser.js";

test("target names tolerate accessibility labels, parenthetical names, and abbreviated surnames",()=>{
  assert.deepEqual(normalizedNameTokens("Michael Antzaras’ profile picture"),["michael","antzaras"]);
  assert.equal(targetNameMatches("Azucena Coronado’s profile picture","Azucena (Susie) Coronado"),true);
  assert.equal(targetNameMatches("Adam Moghaddam’s profile picture","Adam M."),true);
  assert.equal(targetNameMatches("Adam Moghaddam","Alice M."),false);
});
