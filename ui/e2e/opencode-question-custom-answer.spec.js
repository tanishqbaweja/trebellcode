import { test,expect } from "@playwright/test";
import { auditDir,openCode1App,send,stopButton } from "./opencode-relay-app.js";

// An OpenCode question as a person sees it: OpenCode's question tool says when a question takes only its options (custom false), and
// the question dialog offered a typed answer anyway, which OpenCode did not ask for. The real relay and OpenCode 1.x session run against
// a fake OpenCode 1.x server (tests/fixtures/fake-opencode1-server.mjs).
test("an OpenCode question that takes only its options shows no custom answer, and the turn goes on with the person's choices",async({page})=>{
  test.setTimeout(120_000);
  let asked=0;
  await openCode1App(page,async({sessionID,emit,answered})=>{
    const id=`que_theme_${++asked}`;
    emit({type:"question.asked",properties:{id,sessionID,questions:[
      {header:"Color",question:"Which accent color should the theme use?",options:[{label:"Amber",description:"Warm accents"},{label:"Blue",description:"Cool accents"}],custom:false},
      {header:"Name",question:"What should the theme be called?",options:[{label:"Sunrise",description:"A morning theme"}]},
    ]}});
    const reply=await answered(id);
    return `Made the ${reply.answers?.[1]?.[0]||"unnamed"} theme with ${reply.answers?.[0]?.[0]||"no"} accents.`;
  },async({fake})=>{
    const dialog=page.getByRole("dialog",{name:"Agent needs input"});
    // The dialog covers the header, so the mode is switched before each question comes.
    for(const [index,[mode,accent,title]] of [["dark","Blue","Nightfall"],["light","Amber","Daybreak"]].entries()){
      if(await page.evaluate(()=>document.documentElement.dataset.mode)!==mode)await page.getByTestId("appearance-toggle").click();
      await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
      await send(page,`Make me a ${mode} theme`);
      await expect(dialog).toBeVisible({timeout:20_000});
      const [color,name]=[dialog.locator(".question-block").nth(0),dialog.locator(".question-block").nth(1)];
      await expect(color).toContainText("Which accent color should the theme use?");await expect(name).toContainText("What should the theme be called?");
      // The color takes only OpenCode's options; the name takes the person's own words too, as OpenCode's questions do by default.
      await expect(color.getByPlaceholder("Custom answer…")).toHaveCount(0);await expect(color.getByRole("button",{name:"Attach files"})).toHaveCount(0);
      await expect(name.getByPlaceholder("Custom answer…")).toBeVisible();
      await color.getByRole("button",{name:new RegExp(accent)}).click();
      await expect(color.getByRole("button",{name:new RegExp(accent)})).toHaveAttribute("aria-pressed","true");
      await name.getByPlaceholder("Custom answer…").click();await page.keyboard.type(title,{delay:5});
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await expect(dialog).toBeVisible();await page.screenshot({animations:"disabled",path:`${auditDir}opencode-question-choices-only-${mode}-${width}x800.png`})}
      await page.setViewportSize({width:1280,height:800});
      await dialog.getByRole("button",{name:"Submit"}).click();
      await expect(dialog).toHaveCount(0);
      await expect.poll(()=>fake.called(`POST /question/que_theme_${index+1}/reply`).map(call=>call.body)).toEqual([{answers:[[accent],[title]]}]);
      await expect(page.locator(".assistant-message-text").filter({hasText:`Made the ${title} theme with ${accent} accents.`}),"the turn went on with the answers").toBeVisible({timeout:20_000});
      await expect(stopButton(page)).toHaveCount(0);
    }
  });
});
