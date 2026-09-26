import test from "node:test";
import assert from "node:assert/strict";
import { threadReferenceValues } from "../ui/src/thread-references.js";

test("thread menu references prefer the thread cwd and saved branch",()=>{
  assert.deepEqual(threadReferenceValues({id:"thread-7",cwd:"C:/work/widget"},{branch:"feature/payments",cwd:"C:/stale"}),{
    threadId:"thread-7",branch:"feature/payments",path:"C:/work/widget",
  });
  assert.deepEqual(threadReferenceValues({id:"thread-8"},{cwd:"/srv/app"}),{
    threadId:"thread-8",branch:"",path:"/srv/app",
  });
});
