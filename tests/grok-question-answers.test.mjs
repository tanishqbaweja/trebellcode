// Grok Build reads the answer to its ask_user_question by each question's text: the option labels the person chose, or "Other"
// with their own words as notes, and for a single-choice question the chosen option's preview.
import test from "node:test";
import assert from "node:assert/strict";
import { grokQuestionResponse } from "../src/acp-agent-session.mjs";

test("a single choice goes back with its option's preview, a multiple choice without",()=>{
  const layout={question:"Which layout?",options:[{label:"Grid",preview:"  ## Grid\nthree columns  "},{label:"List",preview:"## List"}]};
  assert.deepEqual(grokQuestionResponse([layout],{"Which layout?":"Grid"}),
    {outcome:"accepted",answers:{"Which layout?":["Grid"]},annotations:{"Which layout?":{preview:"## Grid\nthree columns"}}});
  assert.deepEqual(grokQuestionResponse([{...layout,multiSelect:true}],{"Which layout?":["Grid","List"]}),
    {outcome:"accepted",answers:{"Which layout?":["Grid","List"]}});
});

test("answers are read under a question's id first, and own words go with the chosen labels as notes",()=>{
  const questions=[{id:"q1",question:"Which tests?",options:[{label:"Unit"},{label:"E2E"}]},{question:"Anything else?",options:[]}];
  assert.deepEqual(grokQuestionResponse(questions,{q1:[" Unit ","only the fast ones","",7],"Which tests?":["E2E"],"Anything else?":["no","thanks"]}),{
    outcome:"accepted",
    answers:{"Which tests?":["Unit"],"Anything else?":["Other"]},
    annotations:{"Which tests?":{notes:"only the fast ones"},"Anything else?":{notes:"no\nthanks"}},
  });
  assert.deepEqual(grokQuestionResponse(questions,{"Which tests?":["E2E"]}),{outcome:"accepted",answers:{"Which tests?":["E2E"]}},"under its text when its id has nothing");
  assert.deepEqual(grokQuestionResponse(questions,{}),{outcome:"accepted",answers:{}},"an unanswered question is left out");
});
