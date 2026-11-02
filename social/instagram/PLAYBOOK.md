# Workar Instagram: weekly playbook

Account: @workarmentoring, connected to the Facebook Page "Workar" (owned by Nora's own Facebook, never Arash's).
Rules from Nora: post to Instagram only, never Facebook. 3 posts a week + 1 story every day. Nora does not approve anything: make, check and schedule the week yourself, then tell her what was scheduled.

## Style
- Same look as the Workar LinkedIn posts: warm cream, brown Inter headline, kicker in small caps.
- Illustrations from ChatGPT (Nora's ChatGPT, chat "Create Slide One Illustration"): faceless people, warm golden light, not cartoonish, empty soft top 40% for text, calm bottom.
- Cities vary every week (not all Canada): e.g. London, Istanbul, Paris, Dubai, Lisbon, New York, Barcelona, Sydney.
- Workar logo bottom centre on Instagram (top-left stays for LinkedIn).
- Headlines short and plain. Captions end with a workar.me call to action and 6-7 hashtags including #workar.

## Weekly schedule (Vancouver time)
- Posts: Tue, Thu, Sat at 12:00 PM (one of them a 4-slide carousel).
- Stories: every day Mon-Sun at 10:00 AM (stories can reuse the week's illustrations).

## Steps
1. Write the week's plan: 3 posts (headline, kicker, caption) and 7 stories.
2. In ChatGPT ask for each illustration with: "Same style, same size, same empty soft top 40% and calm bottom, faceless people. Image N: <scene, city>. No readable text anywhere."
   Download each with a small script in the ChatGPT tab that fetches the last image blob and saves it as wk-<week>-imgN.png to Downloads.
3. Stage the PNGs from Downloads, render with `node tools/render.js week.json` (posts 1080x1350, `"story": true` gives 1080x1920).
4. Check every image yourself (cut-off text, typos, faces with features) and fix before going on.
5. Copy the finals to Downloads/workar-insta-<week>/, stage them (they land in /mnt/user-data/uploads/Downloads/...), commit them to social/instagram/<week>/.
6. Meta Business Suite (business.facebook.com/latest/composer and /latest/story_composer, asset "Workar, workarmentoring"):
   - In "Post to"/"Share to", untick the Facebook Page "Workar" so only workarmentoring is ticked.
   - Before clicking "Add photo/video", patch HTMLInputElement.prototype.click so file inputs are attached to the page instead of opening the system dialog; then upload with the browser file_upload tool using the staged /mnt/user-data/uploads/... paths.
   - Caption: end the hashtags with a space so the suggestion box does not swallow the last tag.
   - Set date and time, Schedule, then "Maybe later" on the boost dialog (never boost without Nora).
7. Check the Planner shows every item on the right day and time, then send Nora the contact sheets and the list of days and times.
