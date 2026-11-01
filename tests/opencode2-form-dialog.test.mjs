import test from "node:test";
import assert from "node:assert/strict";
import { openCode2FormDialog } from "../src/opencode2-agent-session.mjs";

// An OpenCode 2 form (@opencode/client 2.0.24's FormInfo) as the window's question dialog asks it: string and multiselect fields are
// its questions, any other form is declined by naming what OpenCode asked for, and the person's answers go back by field key.
const form=(...fields)=>({id:"frm_1",sessionID:"ses_main",title:"Questions",fields});
const asks=(...fields)=>openCode2FormDialog(form(...fields));

test("a form with no fields, or fields that are not a list, is declined as one with no questions",()=>{
  for(const value of [form(),{id:"frm_1"},{fields:"k1"},null,undefined]){
    const dialog=openCode2FormDialog(value);
    assert.equal(dialog.declined,"an answer to a form with no questions");
    assert.deepEqual(dialog.questions,[]);
  }
});

test("a field the dialog cannot ask is named by its kind, then by being hidden, then by its conditions",()=>{
  const named=field=>openCode2FormDialog(form(field)).declined;
  assert.equal(named({key:"k",type:"boolean",title:"Deploy?"}),"a yes or no answer");
  assert.equal(named({key:"k",type:"number"}),"a number");
  assert.equal(named({key:"k",type:"integer",minimum:1}),"a whole number");
  assert.equal(named({key:"k",type:"external",url:"https://example.com/sign-in"}),"a visit to a web page");
  assert.equal(named({key:"k",type:"date"}),"a value of type date");
  assert.equal(named({key:"k"}),"a value of type unknown");
  assert.equal(named(null),"a value of type unknown");
  // An empty place in the list of fields is a field with no kind too.
  const sparse=[{key:"a",type:"string"}];sparse[2]={key:"c",type:"string"};
  assert.equal(openCode2FormDialog({fields:sparse}).declined,"a value of type unknown");
  // Only the four kinds have names: no other word is looked up as one.
  for(const kind of ["constructor","toString","__proto__","hasOwnProperty"])assert.equal(named({key:"k",type:kind}),`a value of type ${kind}`);
  assert.equal(named({key:"k",type:"string",hidden:true}),"a field it keeps hidden");
  assert.equal(named({key:"k",type:"multiselect",options:[],when:[{key:"other",op:"eq",value:"yes"}]}),"a conditional field");
  // Its kind decides before hidden, and hidden before conditions.
  assert.equal(named({key:"k",type:"boolean",hidden:true,when:[{key:"other",op:"eq",value:true}]}),"a yes or no answer");
  assert.equal(named({key:"k",type:"string",hidden:true,when:[{key:"other",op:"neq",value:"no"}]}),"a field it keeps hidden");
  // Only hidden: true hides a field, and only a condition makes it depend on another.
  assert.equal(named({key:"k",type:"string",hidden:"yes",when:[]}),null);
  // The first field in the form's order that cannot be asked names the form.
  const {declined,questions}=asks({key:"a",type:"string"},{key:"b",type:"string",hidden:true},{key:"c",type:"boolean"});
  assert.equal(declined,"a field it keeps hidden");
  assert.equal(questions.length,0,"a declined form asks nothing");
});

// A theme form with a field of each shape the dialog asks.
const THEME_FIELDS=[
  {key:"name",type:"string",title:"  Name ",description:" What should the theme be called? ",placeholder:"Dusk",required:true},
  {key:"colors",type:"multiselect",options:[{value:"a",label:"Amber",description:" Warm "},{value:"b",label:"Blue"}],minItems:1},
  {key:7,type:"string",title:"   ",options:[{value:"x",label:"   "},{value:"   ",label:"Yes"},{value:"  ",label:" "},{value:" keep me ",label:""},{value:3,label:"Three"},null]},
  {key:"free",type:"string",title:"Anything else?",options:[{value:"no",label:"No"}],custom:true},
  {key:"tags",type:"multiselect",title:"Tags",options:[]},
];
test("each string or multiselect field is a question of the dialog, in the form's order",()=>{
  const asked=asks(...THEME_FIELDS);
  assert.equal(asked.declined,null);
  assert.deepEqual(asked.questions,[
    {id:"name",header:"Name",question:"What should the theme be called?",multiSelect:false,options:[]},
    // A field with choices is answered only by them, unless it takes the person's own words too (custom).
    {id:"colors",header:"Question 2",question:"Question 2",multiSelect:true,options:[{label:"Amber",description:"Warm",value:"a"},{label:"Blue",description:"",value:"b"}],allowCustomAnswer:false},
    // An option needs a value or a label that is not blank: it is shown by its label (else its value) and answers with its value as
    // given (else its trimmed label).
    {id:"7",header:"Question 3",question:"Question 3",multiSelect:false,options:[{label:"x",description:"",value:"x"},{label:"Yes",description:"",value:"Yes"},{label:"keep me",description:"",value:" keep me "},{label:"Three",description:"",value:"Three"}],allowCustomAnswer:false},
    {id:"free",header:"Anything else?",question:"Anything else?",multiSelect:false,options:[{label:"No",description:"",value:"no"}]},
    {id:"tags",header:"Tags",question:"Tags",multiSelect:true,options:[]},
  ]);
});

// Fields answered with lists, a single text, nothing and blanks.
const ANSWERED_FIELDS=[
  {key:"colors",type:"multiselect",options:[{value:"a",label:"Amber"},{value:"b",label:"Blue"}]},
  {key:"name",type:"string"},
  {key:"one",type:"string"},
  {key:"none",type:"string"},
  {key:"blank",type:"multiselect",options:[{value:"a",label:"Amber"}]},
];
test("the person's answers go back by field key: a multiselect's as their list, any other field's joined with a comma",()=>{
  const {reply}=asks(...ANSWERED_FIELDS);
  assert.deepEqual(reply({colors:["a","  ","b"],name:["Dusk"," theme "],one:"Only",none:[],blank:["", "  "],stray:["x"]}),{colors:["a","b"],name:"Dusk,  theme ",one:"Only"});
  // Words of the person's own go back with the choices, and only text counts.
  assert.deepEqual(reply({colors:["a","Teal",3,null,["b"]],name:[true,"Dusk"]}),{colors:["a","Teal"],name:"Dusk"});
  // No answers make an empty reply, which the session takes as a dismissed or unanswered question.
  for(const answers of [{},null,undefined,"colors",[["a"]]])assert.deepEqual(reply(answers),{});
});

test("a reply keeps every key as its own, and two fields with one key both read its answers, the later field's reply standing",()=>{
  const sent=JSON.parse('{"__proto__":["a"]}'),reply=asks({key:"__proto__",type:"multiselect",options:[{value:"a",label:"A"}]}).reply(sent);
  assert.deepEqual(Object.keys(reply),["__proto__"]);
  assert.deepEqual(Object.getOwnPropertyDescriptor(reply,"__proto__").value,["a"]);
  const twice=asks({key:"k",type:"multiselect",options:[{value:"a",label:"A"}]},{key:"k",type:"string"});
  assert.equal(JSON.stringify(twice.reply({k:["a","b"]})),'{"k":"a, b"}');
});

test("a reply reads back in the person's words: a choice by its label, anything else as given",()=>{
  const {reply,chosen}=asks(
    {key:"colors",type:"multiselect",options:[{value:"a",label:"Amber"},{value:"a",label:"Also amber"},{value:"b",label:"Blue"}]},
    {key:"name",type:"string",options:[{value:"d",label:"Dusk"}],custom:true},
    {key:"skipped",type:"string"},
  );
  assert.deepEqual(chosen(reply({colors:["a","zzz","b"],name:["d"]})),[["Amber","zzz","Blue"],["Dusk"],[]]);
  // A string field's several answers are one reply, which no single choice's value matches.
  assert.deepEqual(chosen(reply({name:["d","Dawn"]})),[[],["d, Dawn"],[]]);
  assert.deepEqual(chosen(null),[[],[],[]]);
});
