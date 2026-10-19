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

- **Chats** — everything you have asked. Its **Monitors** tab holds questions that re-ask
  themselves on a schedule.
- **Resources** — documents, web pages and notes the assistant can draw on.
- **Workspaces** — spaces, which group chats and remember what was said in them, and collections,
  which group resources.
- **Explore** — your tags as a tree, your notes grouped into topics, a graph of how they
  connect, and suggested links between notes.

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
    summary: 'Narrowing a search to news or science, and answering from a collection or your notes.',
    body: `The button to the right of the modes decides *where* an answer may draw from. It is
optional — left alone, everything is used.

**Search categories** apply in balanced and thorough mode: **news**, **science**, **discussions**
and **tech**. Pick one or several to restrict the web search to that kind of site. *news+science*
searches both. Useful when a general search keeps returning the wrong sort of page — product
listings when you wanted research, say.

**Collections** are listed under the same button. Picking one makes that turn also read from the
resources in it, whichever chat you are in, in the way chosen under **Read** — see *Reading a
collection*. Sources from a collection are cited \`[C1]\`, \`[C2]\` so you can always see which shelf
an answer came off.

**Notes first**, under *Your notes* once you have some, answers from your own notes — and the notes
they link with — before searching the web. They are cited \`[N1]\`, \`[N2]\`; the web is searched
only for what they do not cover. Unlike the other choices it is remembered until you turn it off.

Categories apply to the **next message only** and stay lit until you unpick them. Collections, and
how they are read, last for the chat: starting or opening another chat clears them. Nothing is picked
by default, so the button reading *All categories* means all *categories*, not all collections.`,
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

In a long chat the oldest messages eventually drop out of what the model reads. A message with an
attachment is **pinned** so it stays — the pin icon under any message does the same — and the
**Context** meter under the latest answer shows how full the model's view is. Attached to the
wrong chat? The bin icon in the question deletes it and its answer.

A document longer than an attachment may be shows how much was cut, with **Add to library
instead** — then questions find every part of it, not just the beginning.

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
- **Split a long one.** The scissors beside a long answer, or *Split into notes* on a long note,
  proposes several short notes, one idea each. Drop, edit or merge them, or say how you want it
  split and try again.

A note reaches a conversation three ways: found automatically as excerpts, like any resource;
attached whole from the notebook icon beside the paperclip (only notes can be — a file's text is
stored as overlapping excerpts); or with **Notes first**, which answers from your notes before the web.

**Links and tags.** Write \`[[Title]]\` to link to another note or resource — or tap *Insert link*
and pick one. A link to a title nothing has yet offers to create that note. Each resource shows what
it links to and what links to it. A note saved from an answer links back to its chat, opening it at
that answer, and the answer says which notes were made from it. **Tags** such as \`#ml/rag\` are
yours to set on any resource, or write \`#ml/rag\` in a note's text; choosing \`#ml\` in the filter
also shows \`#ml/rag\`. **Connections** draws a resource's links; **Similar content** suggests
resources about the same thing. For the tag tree, the whole graph and suggested links, see
*Organising your notes*.

Use a note for the things you want kept word for word: a brief, a set of requirements, a decision
and why it was made.`,
  },

  explore: {
    title: 'Organising your notes',
    summary: 'The tag tree, topics, the graph, and links the assistant suggests.',
    body: `**Explore**, in the sidebar, shows how your library hangs together. It has four tabs.

**Tags** lists every tag as a tree with counts — \`ml\` holds \`ml/rag\` and \`ml/agents\`. Tap a
tag to see its resources; the **⋯** beside it renames it (sub-tags move along), moves it under
another tag (\`roses\` under \`plants\` becomes \`plants/roses\`), deletes it, or shows it in the graph.
**Tidy tags…** suggests merges and moves for the whole tree; tick the ones you want. At the bottom, **To organise** finds resources without tags and notes without links.

**Topics** groups your notes by what they are about, even untagged and unlinked ones, names each
group, and shows what it lacks. **Tag all**, **Create overview note** or **Link these notes** fixes it
in one go; *Coarser* and *Finer* change how broad the topics are. As a **map**, topics are bubbles you
tap to see their notes as dots, with similar notes drawn close together.

**Graph or map?** The **Graph** shows the links you made, so a note without links is not in it. The
topic **map** shows every note, placed by what it is about — notes that belong together but are not
linked yet show up as a close group with few solid lines.

**Graph** draws every link between your notes and resources, coloured by top-level tag or topic. Narrow it
to a tag, a space or a collection, and tick *Include chats* to see which notes came from the same
conversation. Drag to move, use the buttons to zoom, tap a dot to open it.

**Link notes** goes through your notes one at a time with links the assistant suggests — the quick
way to tie together notes saved from many chats. Each suggestion is a similar note and the words to
link from: **✓** turns those words into a link (or adds it under *See also*), **✕** means never
suggest it again. The same suggestions are one button away on any note: **Suggest links**, under
its links.

Tags never change what the assistant sees, but links do once you ask it to: with **Notes first**
(see *Choosing sources*), a note brings the notes it links with into the answer.`,
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
    body: `A **collection** holds resources and nothing else — no chats, no memory. It is for reference
material that belongs to no particular project, where filing it into a space would mean inventing a
project that does not exist.

Collections and spaces both live under **Workspaces**, in two labelled sections. A resource is
tagged to a collection exactly as it is tagged to a space.

**Using one.** Pick it below the message box and that question reads from its resources — whether
or not the chat is in a space. Choose how under **Read**: Auto, Excerpts, Whole collection or Explore
(see *Reading a collection*). The pick lasts for the chat and is cleared when you start or open
another one.

**Analyze in chat**, on a collection's page, opens a new chat that reads the whole collection — for a
report, or for reviewing a draft you attach against it. The built-in **Collection report** template
does the same from any chat. Save a good answer as a note with the answer's note button.

**Confidential.** The eye icon on a collection's row marks it confidential: its documents are then
read only by locked chats, and picking it locks the chat for good, after asking. See *Keeping things
private*.

**Turning one into a space.** If a collection turns out to be a project after all, promote it from
its own panel and it keeps every resource. This only goes one way: a space that already holds chats
and memories has no sensible reading as a collection.`,
  },

  collectionModes: {
    title: 'Reading a collection',
    summary: 'Auto, excerpts, whole collection or explore — and what each costs in accuracy and time.',
    body: `Once a collection is picked, **Read** decides how it is used. Each way trades accuracy
against time and AI usage.

**Excerpts** — the passages nearest your question, as in any chat.
- *Good for* a fact or passage found in a few places.
- *Can miss* anything not close to your wording; it never covers the whole collection.
- *Cost:* the least — one search and a normal answer.

**Whole collection** — every document. A small collection goes to the model in full; a larger one
is read one document at a time for your question, then answered from what each said.
- *Good for* reports, comparisons, and reviewing a draft against the collection. Nothing is skipped.
- *Can miss* links between documents your question did not ask about (read one at a time), or
  detail buried in a very long prompt (in full).
- *Cost:* the most. On a local model a long prompt takes minutes before the first word; one document
  at a time is much faster there. On a cloud model the collection is paid for on every message. Each
  message reads again, so for a quick follow-up switch to Excerpts.

**Explore** — an agent searches the documents, reads the parts that matter and notes what it finds;
the answer is written from its notes and the passages it saw.
- *Good for* targeted questions: which papers do X, does anything contradict my section 3.
- *Can miss* what it judges irrelevant; the footer shows how many calls and notes it used. Passages
  that score as unrelated to your question and the agent's searches are left out of the answer; an
  administrator sets how strict that is.
- *Cost:* 5–20 short model calls. Works best on a model that is good with tools.
- *Web:* only if you tick **Also search the web**, for what the documents lack. Never when locked.

**Auto**, the default, asks a small local model which of the three fits each message — one quick
extra call — and the footer says what it chose and why, so you can pick yourself next time.

**In a space**, the same choice reads the space's own resources, with no collection picked: the
selector is labelled *Read this space's resources*. Excerpts is the default there, as in any space
chat; Auto is offered only once a collection is picked, so ordinary messages cost no extra call.
Whole collection and Explore read the space's resources and any picked collections together, and
still use the space's memory. **Analyze in chat**, on the space's page, opens a chat set to Whole
collection.

The progress log shows each stage as it runs, and the footer how the collection was read.`,
  },

  monitors: {
    title: 'Monitors',
    summary: 'A question that asks itself on a schedule.',
    body: `A **monitor** re-runs a question by itself — every six hours, daily, weekly — and keeps
each run as an ordinary chat you can open, read and continue.

**Making one.** *New monitor* under Chats → Monitors. Give it a question, a research mode and an
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
under **Custom**, and can be edited or deleted from there.

**Recipes.** In the Studio's *Recipe* section, add **instruction notes** (a style guide, a
procedure), **examples** whose form to imitate, and collections to read. The template becomes a
recipe: picking it puts a *Recipe* chip in the message box, and every message of that chat follows
it until you remove the chip. The notes act as instructions only this way — never when a search
happens to find them. A note you haven't reviewed gets a warning beside the chip.`,
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
    summary: 'Three levels of protection: cloud, local, locked — and confidential content.',
    body: `Everything you write, upload and receive is stored on this machine. But once the assistant has
read a document, anything it can send outwards is a way for that document to leave — and a document
can *contain instructions* the model will follow.

There are three levels of protection:

- **A cloud model** — only if an admin has given you access and you pick one. The provider receives
  the whole prompt: your question, the conversation and any document excerpts. You confirm this
  once, and the answer says where it was sent.
- **Local models (the default)** — nothing goes to a model provider, but web searches and fetched pages
  can carry words from your documents. Requests that look like they do are held for your approval.
  That is detection, and it can be fooled.
- **Locked** — no web search, page fetching, image generation or cloud models at all. The routes out
  do not exist, so nothing has to be judged.

**Two ways to lock.**
- A **locked space** (padlock): every chat in it is locked. Lock it before anything is in it; once it
  holds a chat or a memory it cannot be unlocked, and its chats can only move to another locked space.
- **Confidential content** (eye icon on a collection, or on a resource's page): only locked chats may
  read it. Picking a confidential collection or attaching a confidential note locks that chat for
  good, after asking; the chat's banner says what locked it. Unlocked chats leave confidential
  documents out, and the footer says so. The mark can be removed any time; locked chats stay locked.

**A document for one chat only:** attach it with the paperclip in a locked chat instead of adding
it to your library.

**One limit worth knowing.** A lock removes the model's tools; it does not change where the model
runs. If this installation's own models are hosted elsewhere, documents reach them anyway.`,
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
- **Theme** — Dark, Light, or E-ink (black on white, no animations) for e-paper readers; graphs and badges keep a few colours that also work in greyscale.
- **Font size** and **Timezone** — the latter decides what *02:00* means to a monitor.
- **Export** — downloads your notes and resources as an Obsidian vault, links and tags intact;
  tick the box to include your chats and generated images too.
- **Password** — changing it signs out your other devices and keeps this one.`,
  },
} as const
