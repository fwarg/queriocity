/** The English guide, and the type every other language is measured against.
 *
 *  Distilled from the user guide in README.md: shorter, second person, one screen per topic. The
 *  README stays the reference — this is the introduction, and it should stay short enough to read. */

export const en = {
  gettingStarted: {
    title: 'Getting started',
    summary: 'What Queriocity is, and what happens when you ask it something.',
    body: `Queriocity is a research assistant that runs on your own machine. You ask a question, it
searches the web, reads what it finds, and answers with **citations** you can click to check.

**Ask your first question.** Type it in the box at the bottom and press Enter. A number like
\`[1]\` in the answer is a source — hover it to see where it came from, click it to open it.

**Every conversation is kept.** It appears in the sidebar, and **Chats** lists them all with a
search box that looks inside the messages, not just the titles. Under a finished answer you can
**Retry** it, have it read aloud, save it as a note, or export the chat as a file.

**The four things in the sidebar:**

- **Chats** — everything you have asked.
- **Resources** — documents, web pages and notes the assistant can draw on.
- **Workspaces** — spaces, which group chats and remember what was said in them, and collections,
  which group resources.
- **Monitors** — questions that re-ask themselves on a schedule.

None of them are needed for asking a question. Add them when you want them.`,
  },

  modes: {
    title: 'Research modes',
    summary: 'flash, balanced and thorough — which to pick, and why it matters.',
    body: `Below the message box are three modes. They decide how much work goes into your answer,
and picking the right one is the single biggest difference you can make.

**flash** — no web search at all. The model answers from what it already knows, in five sentences
or less. Instant, and fine for *"what does this word mean"*. Not for anything recent.

**balanced** — the default, and the right answer most of the time. Your question is rewritten into
good search queries, those are run, and the model reads the results before answering. Comes with
citations.

**thorough** — researches the topic from several angles, then hands everything to a second pass
whose only job is to write. Slower — often a minute or more — and noticeably better for anything
you would otherwise have to ask three times.

**image** — appears only if this installation has image generation set up. See *Images*.

**You can change mode and ask again.** Under an answer, **Retry** re-runs the same question in
whatever mode is selected *now* and replaces the answer instead of adding a second one. Asking in
balanced and retrying in thorough is a normal thing to do.`,
  },

  sources: {
    title: 'Choosing sources',
    summary: 'Narrowing a search to news or science, and answering from a collection.',
    body: `The button to the right of the modes decides *where* an answer may draw from. It is
optional — left alone, everything is used.

**Search categories** apply in balanced and thorough mode: **news**, **science**, **discussions**
and **tech**. Pick one or several to restrict the web search to that kind of site. *news+science*
searches both. Useful when a general search keeps returning the wrong sort of page — product
listings when you wanted research, say.

**Collections** are listed under the same button. Ticking one makes that turn also read from the
resources in it, whichever chat you are in. Excerpts from a collection are cited \`[C1]\`, \`[C2]\`
so you can always see which shelf an answer came off.

Both choices apply to the **next message only** and stay lit until you unpick them — they are not
saved on the chat. Nothing is picked by default, so the button reading *All categories* means all
*categories*, not all collections.`,
  },

  resources: {
    title: 'Documents and web pages',
    summary: 'Three ways to give the assistant something to read, and when to use each.',
    body: `**Attach a file to one message.** The paperclip beside the message box. The text is
pulled out and sent with your question, the file itself is not kept. This is what you want for
*"summarise this contract"* — the whole document goes to the model, and nothing is stored.

**Add it to your library.** The **Resources** view. An uploaded file is split into pieces and
indexed, and from then on the assistant finds the relevant pieces by itself whenever a question
touches them — you never have to mention the file. This is for material you want available across
many conversations. PDF, text, Markdown, CSV, HTML and images all work, up to 50 MB.

**Add a web page or a YouTube video.** *+ Add URL* in the same view. The page is fetched, or the
video's transcript is, and stored exactly like an upload.

The difference that matters: an **attachment** is read whole, once. A **library resource** is
found in pieces, forever. Ask about a document as a whole with the paperclip; build a shelf you can
ask across with the library.

Click any resource to see its summary, rename it, check the excerpts that were actually indexed,
or run **Transform** over it — summarise it, pull out the key points, list the open questions —
and keep the result as a note.`,
  },

  notes: {
    title: 'Notes',
    summary: 'Text you write yourself, kept exactly as written.',
    body: `A **note** is a resource you write instead of upload. It is indexed like everything else
in your library, so the assistant finds it on its own, but unlike a file it stays editable.

**Three ways to make one:**

- **Write it.** *+ New note* in Resources, with a preview toggle.
- **Save an answer.** The notebook icon beside an assistant message opens the editor already
  filled in with the answer, the question as its title, and the sources listed at the bottom.
- **Transform a resource.** Summarise a document, then keep the summary.

A note reaches a conversation two ways: found automatically as excerpts, like any resource, or
attached whole from the notebook icon beside the paperclip. Only notes can be attached that way —
a file's text is stored as overlapping excerpts, so sending one whole would repeat itself; the
paperclip already covers that case.

Use a note for the things you want kept word for word: a brief, a set of requirements, a decision
and why it was made.`,
  },

  spaces: {
    title: 'Spaces and memory',
    summary: 'Group chats around a project, and let the assistant remember it.',
    body: `A **space** is a project. Put related chats in it and it starts to accumulate a
**memory**: after each answer, the facts and decisions worth keeping are extracted and saved, and
later questions in that space get the relevant ones back automatically.

**Getting one going:**

1. **Workspaces → +** to create it.
2. Assign a chat to it from the button beside the chat's title, or from the space itself. Chats
   assigned later are read back through, so nothing is lost by adding them afterwards.
3. **Tag resources to it** so every question in the space can draw on them.

Memories are chosen by how relevant they are to what you just asked, not by age — a space can hold
far more than fits in one question without the older ones becoming unreachable. You can read,
edit, add and delete them in the space's panel. **★** on a memory means *always include this one*,
for standing instructions that must never be dropped.

**Compact** merges near-duplicates when the list gets long. **Recreate all** throws the automatic
memories away and extracts them again from the chats. Anything you wrote yourself survives both.

A space can also be **locked**, which cuts it off from the web entirely — see *Privacy*.`,
  },

  collections: {
    title: 'Collections',
    summary: 'A shelf of resources, with no chats and no memory.',
    body: `A **collection** holds resources and nothing else. No chats, no memory, no lock. It is
for reference material that belongs to no particular project — where filing it into a space would
mean inventing a project that does not exist.

Collections and spaces both live under **Workspaces**, in two labelled sections. A resource is
tagged to a collection exactly as it is tagged to a space.

**Using one.** Tick it below the message box and that question also reads from its resources —
whether or not the chat is in a space. The tick lasts until you remove it and is not saved on the
chat, so it costs no more to change than the research mode beside it.

**Turning one into a space.** If a collection turns out to be a project after all, promote it from
its own panel and it keeps every resource. This only goes one way: a space that already holds
chats and memories has no sensible reading as a collection.`,
  },

  monitors: {
    title: 'Monitors',
    summary: 'A question that asks itself on a schedule.',
    body: `A **monitor** re-runs a question by itself — every six hours, daily, weekly — and keeps
each run as an ordinary chat you can open, read and continue.

**Making one.** *New monitor* in the Monitors view. Give it a question, a research mode and an
interval; daily and weekly monitors can also be given an hour of the day. The first run happens
after one full interval, so use **▶ Run now** if you want to see it work immediately.

**Keep count** is how many runs are kept — three by default. Older ones are deleted as new ones
arrive. If you reply to a run it becomes a normal chat and stops being pruned, so anything you
follow up on is safe.

**News sources.** A monitor can be pointed at a catalogue of news feeds instead of at web search,
grouped by region and topic. The feeds are fetched at run time and read directly.

Your administrator can publish **global monitors** for everyone to subscribe to. Subscribing gives
you your own copy of every run — nothing is shared between users.`,
  },

  templates: {
    title: 'Templates',
    summary: 'Fill in a short form instead of wording the prompt yourself.',
    body: `The grid icon beside the message box opens the **templates**. A template turns a small
form into a well-worded question, and sets the research mode that suits it.

The built-in ones cover a deep research report, a side-by-side comparison, an explanation pitched
at an audience you choose, a news round-up, and — where image generation is available — a drawing.
Fill in the fields marked \`*\`, press **Use template**, and the assembled text lands in the message
box where you can still edit it before sending.

**Your own templates.** *Create custom template* at the bottom of the picker opens **Prompt
Studio**. Write a prompt, mark the variable parts with double braces — \`Explain {{concept}} to a
{{audience}}\` — and the Studio turns each one into a field. Fill in test values, press **▶ Run**,
see what comes back, adjust, and save it when it behaves. Saved templates appear in the picker
under **Custom**, and can be edited or deleted from there.`,
  },

  images: {
    title: 'Images',
    summary: 'Generating and editing pictures, where the installation supports it.',
    body: `If this installation has image generation configured, a fourth mode — **image** —
appears beside the others. Select it and describe what you want: *"draw a mountain landscape at
sunset"*.

The assistant may search the web first when the subject is unfamiliar to it, so the picture is
based on something real. If it does, it says so in a line above the image and lists what it read.

**Editing.** Ask for a change and the most recent image is redrawn: *"make it raining"*, *"make
the wolf grey"*. An edit inherits the settings of the image it changes, so you do not have to
restate them. Colour changes need a bigger change than they sound like — if a recolour comes back
half-done, ask more firmly or name a strength: *"redo it at strength 0.6"*.

**Repeating a result.** Each picture is drawn from a random **seed**, so asking twice gives two
different images. Say *"use seed 12345"* to pin it, then change one thing in your description —
the difference you see is the change you made.

Finished images have a **Download PNG** link and carry an *AI-generated* marker. Whether that
marker is also drawn onto the downloaded file is your choice, under Settings.`,
  },

  privacy: {
    title: 'Keeping things private',
    summary: 'Locked spaces, and how to analyse a document that must not leave.',
    body: `Everything you write, upload and receive is stored on this machine. But once the
assistant has read a document, anything it can send outwards is a way for that document to leave —
and a document can *contain instructions* the model will follow. Queriocity assumes what it reads
may be hostile.

A **locked space** answers this by removing the ability rather than policing it. Chats in a locked
space get no web search, no page fetching and no image generation. There is nothing to judge, so
there is nothing to get wrong.

**To analyse a sensitive document:**

1. **Create a space and lock it first**, before anything is in it.
2. **Start a new chat inside that space.**
3. **Attach the document with the paperclip** — not to your library.

Step 3 matters as much as the others. A file in your **library** can be found from *every* chat you
own, including ones with web access. A chat attachment never enters the library, so it exists only
in that locked conversation.

**Locking is close to one-way.** An empty space can be unlocked freely; one that holds a chat or a
memory cannot, because unlocking would hand web access to everything gathered on the promise that
there was none. Chats in a locked space can only move to another locked space, and deleting a
locked space deletes its chats rather than releasing them.

**One limit worth knowing.** Locking removes the model's tools; it does not change where the model
runs. If this installation uses a hosted model rather than a local one, your document is sent there
before any tool could exist.`,
  },

  settings: {
    title: 'Settings',
    summary: 'The handful of settings actually worth changing.',
    body: `**Settings**, at the bottom of the sidebar. Everything is per user. The ones that change
your day:

- **Custom system prompt** — standing instructions added to every question. *"Answer in Swedish"*,
  *"be concise"*, *"always show your reasoning"*.
- **About you** — off by default. A short list of facts that are true in *every* chat, space or
  not: how you want answers written, what you work on, lasting constraints. Nothing is written
  automatically; you type it, accept a suggestion, or let the assistant offer one. **Suggest from
  my chats** reads your recent conversations and proposes some, which you accept one at a time.
- **Language** — the interface language. It does not affect what language you get answers in: the
  assistant replies in whichever language you asked.
- **Show search process** — displays the searches and snippets above the answer, folded shut.
  Worth turning on once to see how an answer was arrived at.
- **Font size** and **Timezone** — the latter decides what *02:00* means to a monitor.
- **Password** — changing it signs out your other devices and keeps this one.`,
  },
} as const
