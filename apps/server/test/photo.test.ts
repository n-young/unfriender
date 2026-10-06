import test from "node:test";
import assert from "node:assert/strict";
import { assertPlatformPhotoUrl } from "../src/photo.js";

test("profile photo proxy accepts only the expected HTTPS CDN hosts",()=>{
  assert.equal(assertPlatformPhotoUrl("linkedin","https://media.licdn.com/dms/image/example").hostname,"media.licdn.com");
  assert.equal(assertPlatformPhotoUrl("facebook","https://scontent-sea5-1.xx.fbcdn.net/photo.jpg").hostname,"scontent-sea5-1.xx.fbcdn.net");
  assert.equal(assertPlatformPhotoUrl("instagram","https://scontent.cdninstagram.com/photo.jpg").hostname,"scontent.cdninstagram.com");
  assert.throws(()=>assertPlatformPhotoUrl("facebook","http://127.0.0.1/private"));
  assert.throws(()=>assertPlatformPhotoUrl("linkedin","https://licdn.com.evil.example/photo"));
  assert.throws(()=>assertPlatformPhotoUrl("instagram","https://user:secret@cdninstagram.com/photo"));
});
