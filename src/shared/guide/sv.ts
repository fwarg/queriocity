/** Den svenska guiden. Termerna följer gränssnittet: utrymme, samling, bevakning, resurs. */

import type { Guide } from './index.ts'

export const sv = {
  gettingStarted: {
    title: 'Kom igång',
    summary: 'Vad Queriocity är, och vad som händer när du frågar något.',
    body: `Queriocity är en researchassistent som kör på din egen maskin. Du ställer en fråga, den
söker på nätet, läser det den hittar och svarar med **källhänvisningar** du kan klicka på.

**Ställ din första fråga.** Skriv den i rutan längst ner och tryck Enter. En siffra som \`[1]\` i
svaret är en källa — håll muspekaren över den för att se varifrån den kommer, klicka för att öppna.

**Alla samtal sparas.** De hamnar i sidopanelen, och **Chattar** listar allihop med en sökruta som
letar inne i meddelandena, inte bara i titlarna. Under ett färdigt svar kan du köra om det med
**Försök igen**, få det uppläst, spara det som en anteckning eller exportera hela chatten.

**De fyra sakerna i sidopanelen:**

- **Chattar** — allt du har frågat. Fliken **Bevakningar** rymmer frågor som ställer sig själva
  enligt ett schema.
- **Resurser** — dokument, webbsidor och anteckningar som assistenten kan använda.
- **Arbetsytor** — utrymmen, som grupperar chattar och minns vad som sagts i dem, och samlingar,
  som grupperar resurser.
- **Utforska** — dina taggar som ett träd, dina anteckningar grupperade i ämnen, en graf över hur
  de hänger ihop, och föreslagna länkar mellan anteckningar.

Inget av det behövs för att ställa en fråga. Lägg till det när du vill ha det.`,
  },

  modes: {
    title: 'Researchlägen',
    summary: 'snabb, balanserad och grundlig — vilket du ska välja, och varför det spelar roll.',
    body: `Under meddelanderutan finns tre lägen. De avgör hur mycket arbete som läggs på ditt
svar, och att välja rätt är den enskilt största skillnad du kan göra.

**snabb** — ingen webbsökning alls. Modellen svarar utifrån vad den redan kan, på högst fem
meningar. Direkt, och alldeles utmärkt för *"vad betyder det här ordet"*. Inte för något aktuellt.

**balanserad** — standardläget, och rätt svar för det mesta. Din fråga skrivs om till bra
sökfrågor, de körs, och modellen läser resultaten innan den svarar. Med källhänvisningar.

**grundlig** — undersöker ämnet från flera håll och lämnar sedan över allt till en andra omgång
vars enda uppgift är att skriva. Långsammare — ofta en minut eller mer — och märkbart bättre för
sådant du annars hade fått fråga om tre gånger.

**bild** — visas bara om den här installationen har bildgenerering. Se *Bilder*.

**Du kan byta läge och fråga igen.** Under ett svar kör **Försök igen** samma fråga i det läge som
är valt *nu*, och ersätter svaret i stället för att lägga till ett till. Att fråga balanserat och
köra om grundligt är helt normalt.`,
  },

  sources: {
    title: 'Välja källor',
    summary: 'Avgränsa sökningen till nyheter eller vetenskap, och svara utifrån en samling eller dina anteckningar.',
    body: `Knappen till höger om lägena avgör *varifrån* ett svar får hämta. Den är valfri — rör du
den inte används allt.

**Sökkategorier** gäller i balanserat och grundligt läge: **nyheter**, **vetenskap**,
**diskussioner** och **teknik**. Välj en eller flera för att begränsa webbsökningen till den sortens
sidor. *nyheter+vetenskap* söker i båda. Användbart när en vanlig sökning envisas med fel sorts
träffar — produktsidor när du ville ha forskning, till exempel.

**Samlingar** ligger under samma knapp. Väljer du en läser den omgången också ur resurserna i den,
oavsett vilken chatt du är i, på det sätt som är valt under **Läs** — se *Läsa en samling*. Källor ur
en samling får hänvisningarna \`[C1]\`, \`[C2]\` så att du alltid ser vilken hylla svaret kommer från.

**Anteckningar först**, under *Dina anteckningar* när du har några, svarar utifrån dina egna
anteckningar — och anteckningarna de länkar ihop med — innan webben söks. De hänvisas som \`[N1]\`,
\`[N2]\`; webben söks bara för det de inte täcker. Till skillnad från de andra valen kommer det ihåg
tills du stänger av det.

Kategorier gäller **bara nästa meddelande** och lyser tills du tar bort dem. Samlingar, och hur de
läses, gäller för chatten: att starta eller öppna en annan chatt nollställer dem. Ingenting är valt
från början, så när knappen säger *Alla kategorier* betyder det alla *kategorier*, inte alla samlingar.`,
  },

  resources: {
    title: 'Dokument och webbsidor',
    summary: 'Tre sätt att ge assistenten något att läsa, och när du använder vilket.',
    body: `**Bifoga en fil till ett meddelande.** Gemet bredvid meddelanderutan. Texten plockas ut
och skickas med din fråga, filen sparas inte. Det här är vad du vill ha för *"sammanfatta det här
avtalet"* — hela dokumentet går till modellen, och ingenting lagras.

**Lägg den i biblioteket.** Vyn **Resurser**. En uppladdad fil delas i bitar och indexeras, och
därefter hittar assistenten de relevanta bitarna själv så snart en fråga rör dem — du behöver
aldrig nämna filen. Det här är för material du vill ha tillgängligt i många samtal. PDF, text,
Markdown, CSV, HTML och bilder fungerar, upp till 50 MB.

**Lägg till en webbsida eller en YouTube-video.** *+ Lägg till URL* i samma vy. Sidan hämtas, eller
videons transkript, och lagras precis som en uppladdning.

I en lång chatt faller de äldsta meddelandena till slut ur det modellen läser. Ett meddelande med
bilaga **fästs** så att det stannar kvar — nålen under varje meddelande gör samma sak — och mätaren
**Kontext** under det senaste svaret visar hur fullt modellens fönster är. Bifogat i fel chatt?
Papperskorgen i frågan tar bort den och dess svar.

Ett dokument som är längre än en bilaga får vara visar hur mycket som kapades, med **Lägg i
biblioteket i stället** — då hittar frågor alla delar av det, inte bara början.

Skillnaden som betyder något: en **bilaga** läses hel, en gång. En **biblioteksresurs** hittas i
bitar, för alltid. Fråga om ett dokument i sin helhet med gemet; bygg en hylla du kan fråga tvärs
över med biblioteket.

Klicka på en resurs för att se sammanfattningen, byta namn på den, granska utdragen som faktiskt
indexerades, eller köra **Omvandla** över den — sammanfatta, plocka ut huvudpunkterna, lista de
öppna frågorna — och spara resultatet som en anteckning.`,
  },

  notes: {
    title: 'Anteckningar',
    summary: 'Text du skriver själv, bevarad exakt som du skrev den.',
    body: `En **anteckning** är en resurs du skriver i stället för att ladda upp. Den indexeras som
allt annat i biblioteket, så assistenten hittar den på egen hand, men till skillnad från en fil går
den att redigera efteråt.

**Tre sätt att skapa en:**

- **Skriv den.** *+ Ny anteckning* i Resurser, med förhandsgranskning.
- **Spara ett svar.** Anteckningsikonen bredvid ett assistentmeddelande öppnar redigeraren redan
  ifylld med svaret, frågan som titel och källorna listade sist.
- **Omvandla en resurs.** Sammanfatta ett dokument och behåll sammanfattningen.
- **Dela upp en lång.** Saxen bredvid ett långt svar, eller *Dela upp i anteckningar* på en lång
  anteckning, föreslår flera korta anteckningar, en idé i varje. Ta bort, redigera eller slå ihop
  dem, eller säg hur du vill ha den uppdelad och försök igen.

En anteckning når ett samtal på tre sätt: automatiskt som utdrag, likt vilken resurs som helst;
hel genom anteckningsikonen bredvid gemet (bara anteckningar kan bifogas så — en fils text lagras
som överlappande utdrag); eller med **Anteckningar först**, som svarar utifrån dina anteckningar
före webben.

**Länkar och taggar.** Skriv \`[[Titel]]\` för att länka till en annan anteckning eller resurs —
eller tryck *Infoga länk* och välj en. En länk till en titel som inget har ännu erbjuder att skapa
den anteckningen. Varje resurs visar vad den länkar till och vad som länkar till den. En anteckning
sparad från ett svar länkar tillbaka till sin chatt och öppnar den vid svaret, och svaret visar
vilka anteckningar som gjorts av det. **Taggar** som \`#ml/rag\` sätter du själv på vilken resurs
som helst, eller skriver \`#ml/rag\` i en antecknings text; väljer du \`#ml\` i filtret visas även
\`#ml/rag\`. **Kopplingar** ritar en resurs länkar; **Liknande innehåll** föreslår resurser om samma
sak. Om taggträdet, hela grafen och föreslagna länkar, se *Ordna dina anteckningar*.

Använd en anteckning för det du vill ha bevarat ord för ord: en beställning, en kravlista, ett
beslut och skälet till det.`,
  },

  explore: {
    title: 'Ordna dina anteckningar',
    summary: 'Taggträdet, ämnen, grafen och länkar som assistenten föreslår.',
    body: `**Utforska**, i sidopanelen, visar hur ditt bibliotek hänger ihop. Den har fyra flikar.

**Taggar** visar alla taggar som ett träd med antal — \`ml\` rymmer \`ml/rag\` och \`ml/agents\`.
Tryck på en tagg för att se dess resurser; **⋯** bredvid byter namn på den (undertaggarna följer
med), flyttar den under en annan tagg (\`rosor\` under \`växter\` blir \`växter/rosor\`), tar bort
den eller visar den i grafen. Längst ner hittar **Att organisera** resurser utan
taggar och anteckningar utan länkar.

**Ämnen** grupperar dina anteckningar efter vad de handlar om, även otaggade och olänkade, namnger
varje grupp och visar vad den saknar. **Tagga alla**, **Skapa översiktsanteckning** eller **Länka
anteckningarna** åtgärdar det på en gång; *Grövre* och *Finare* ändrar hur breda ämnena är. Som
**karta** är ämnena bubblor du trycker på för att se deras anteckningar som punkter, där liknande
anteckningar hamnar nära varandra.

**Graf eller karta?** **Grafen** visar länkarna du gjort, så en anteckning utan länkar finns inte med.
Ämnes**kartan** visar alla anteckningar, placerade efter vad de handlar om — anteckningar som hör
ihop men ännu inte är länkade syns som en tät grupp med få heldragna linjer.

**Graf** ritar alla länkar mellan dina anteckningar och resurser, färgade efter toppnivåtagg eller ämne.
Begränsa den till en tagg, ett utrymme eller en samling, och kryssa i *Ta med chattar* för att se
vilka anteckningar som kom från samma samtal. Dra för att flytta, zooma med knapparna, tryck på en
punkt för att öppna den.

**Länka anteckningar** går igenom dina anteckningar en i taget med länkar som assistenten
föreslår — det snabba sättet att knyta ihop anteckningar sparade från många chattar. Varje förslag
är en liknande anteckning och orden att länka från: **✓** gör orden till en länk (eller lägger den
under *Se även*), **✕** betyder att den aldrig föreslås igen. Samma förslag finns ett tryck bort på
varje anteckning: **Föreslå länkar**, under dess länkar.

Taggar ändrar aldrig vad assistenten ser, men länkar gör det när du ber om det: med **Anteckningar
först** (se *Välja källor*) tar en anteckning med sig anteckningarna den länkar ihop med in i svaret.`,
  },

  spaces: {
    title: 'Utrymmen och minne',
    summary: 'Gruppera chattar kring ett projekt, och låt assistenten minnas det.',
    body: `Ett **utrymme** är ett projekt. Lägg besläktade chattar i det så börjar det bygga ett
**minne**: efter varje svar plockas de fakta och beslut ut som är värda att spara, och senare
frågor i utrymmet får tillbaka de relevanta automatiskt.

**Så kommer du igång:**

1. **Arbetsytor → +** för att skapa det.
2. Lägg en chatt i det med knappen bredvid chattens titel, eller från utrymmet självt. Chattar som
   läggs till senare läses igenom i efterhand, så ingenting går förlorat.
3. **Tagga resurser till det** så att varje fråga i utrymmet kan använda dem.

Minnen väljs efter hur relevanta de är för det du just frågade, inte efter ålder — ett utrymme kan
alltså rymma långt fler än vad som får plats i en fråga utan att de äldre blir oåtkomliga. Du kan
läsa, ändra, lägga till och ta bort dem i utrymmets panel. **★** på ett minne betyder *ta alltid
med det här*, för stående instruktioner som aldrig får falla bort.

**Komprimera** slår ihop nästan likadana minnen när listan blir lång. **Återskapa alla** slänger de
automatiska minnena och plockar ut dem ur chattarna igen. Det du skrivit själv överlever båda.

Ett utrymme kan också **låsas**, vilket kopplar bort det från nätet helt — se *Hålla saker
privata*.`,
  },

  collections: {
    title: 'Samlingar',
    summary: 'En hylla med resurser, utan chattar och utan minne.',
    body: `En **samling** innehåller resurser och ingenting annat — inga chattar, inget minne. Den är till för
referensmaterial som inte hör till något särskilt projekt, där det skulle betyda att hitta på ett
projekt som inte finns om du lade det i ett utrymme.

Samlingar och utrymmen ligger båda under **Arbetsytor**, i två märkta avdelningar. En resurs taggas
till en samling precis som till ett utrymme.

**Använda en.** Välj den under meddelanderutan så läser frågan ur dess resurser — oavsett om chatten
ligger i ett utrymme. Välj hur under **Läs**: Auto, Utdrag, Hela samlingen eller Utforska (se *Läsa en
samling*). Valet gäller för chatten och nollställs när du startar eller öppnar en annan.

**Analysera i chatt**, på samlingens sida, öppnar en ny chatt som läser hela samlingen — för en
rapport, eller för att granska ett utkast du bifogar mot den. Den inbyggda mallen **Samlingsrapport**
gör samma sak från vilken chatt som helst. Spara ett bra svar som anteckning med svarets
anteckningsknapp.

**Konfidentiell.** Ögonikonen på samlingens rad markerar den som konfidentiell: dess dokument läses då
bara av låsta chattar, och att välja den låser chatten för gott, efter en fråga. Se *Hålla saker
privata*.

**Göra om den till ett utrymme.** Visar sig en samling vara ett projekt ändå, gör om den från dess egen
panel så behåller den alla resurser. Det går bara åt ett håll: ett utrymme som redan har chattar och
minnen går inte att läsa som en samling.`,
  },

  collectionModes: {
    title: 'Läsa en samling',
    summary: 'Auto, utdrag, hela samlingen eller utforska — och vad var och en kostar i träffsäkerhet och tid.',
    body: `När en samling är vald avgör **Läs** hur den används. Varje sätt väger träffsäkerhet mot
tid och AI-användning.

**Utdrag** — de stycken som ligger närmast din fråga, som i vilken chatt som helst.
- *Bra för* ett faktum eller ett stycke som finns på några få ställen.
- *Kan missa* det som inte ligger nära dina ord; det täcker aldrig hela samlingen.
- *Kostnad:* minst — en sökning och ett vanligt svar.

**Hela samlingen** — alla dokument. En liten samling skickas till modellen i sin helhet; en större
läses ett dokument i taget för din fråga, och svaret skrivs utifrån vad vart och ett sade.
- *Bra för* rapporter, jämförelser och att granska ett utkast mot samlingen. Inget hoppas över.
- *Kan missa* kopplingar mellan dokument som frågan inte bad om (ett i taget), eller detaljer som
  drunknar i en mycket lång prompt (i sin helhet).
- *Kostnad:* störst. På en lokal modell tar en lång prompt minuter före första ordet; ett dokument i
  taget går mycket fortare där. På en molnmodell betalas samlingen vid varje meddelande. Varje
  meddelande läser om, så byt till Utdrag för en snabb följdfråga.

**Utforska** — en agent söker i dokumenten, läser de delar som spelar roll och antecknar vad den
hittar; svaret skrivs utifrån anteckningarna och de stycken den såg.
- *Bra för* riktade frågor: vilka artiklar gör X, säger något emot mitt avsnitt 3.
- *Kan missa* det den bedömer som oviktigt; sidfoten visar hur många anrop och anteckningar den använde.
  Avsnitt som bedöms sakna samband med din fråga och agentens sökningar lämnas utanför svaret; en
  administratör ställer in hur strängt det är.
- *Kostnad:* 5–20 korta modellanrop. Fungerar bäst på en modell som är bra på verktyg.
- *Webb:* bara om du kryssar i **Sök även på webben**, för det dokumenten saknar. Aldrig i låst läge.

**Auto**, förvalet, frågar en liten lokal modell vilket av de tre som passar varje meddelande — ett
snabbt extra anrop — och sidfoten säger vad den valde och varför, så att du kan välja själv nästa gång.

**I ett utrymme** läser samma val utrymmets egna resurser, utan att någon samling är vald: väljaren
heter då *Läs utrymmets resurser*. Där är Utdrag förvalt, som i alla chattar i ett utrymme; Auto
erbjuds först när en samling är vald, så vanliga meddelanden kostar inget extra anrop. Hela samlingen
och Utforska läser utrymmets resurser och valda samlingar tillsammans, med utrymmets minne. **Analysera i chatt**, på utrymmets sida, öppnar en chatt inställd på Hela samlingen.

Förloppsloggen visar varje steg medan det pågår, och sidfoten hur samlingen lästes.`,
  },

  monitors: {
    title: 'Bevakningar',
    summary: 'En fråga som ställer sig själv enligt ett schema.',
    body: `En **bevakning** kör om en fråga av sig själv — var sjätte timme, dagligen, veckovis —
och sparar varje körning som en vanlig chatt du kan öppna, läsa och fortsätta i.

**Skapa en.** *Ny bevakning* under Chattar → Bevakningar. Ge den en fråga, ett researchläge och ett
intervall; dagliga och veckovisa bevakningar kan dessutom få en klockslag. Första körningen sker
efter ett helt intervall, så använd **▶ Kör nu** om du vill se den arbeta direkt.

**Antal att spara** är hur många körningar som behålls — tre som standard. Äldre tas bort när nya
kommer. Svarar du i en körning blir den en vanlig chatt och rensas inte längre, så allt du följt
upp är i säkerhet.

**Nyhetskällor.** En bevakning kan riktas mot en katalog med nyhetsflöden i stället för mot
webbsökning, grupperade efter region och ämne. Flödena hämtas vid körning och läses direkt.

Din administratör kan publicera **globala bevakningar** som alla kan prenumerera på. Du får din
egen kopia av varje körning — ingenting delas mellan användare.`,
  },

  templates: {
    title: 'Mallar',
    summary: 'Fyll i ett kort formulär i stället för att formulera frågan själv.',
    body: `Rutnätsikonen bredvid meddelanderutan öppnar **mallarna**. En mall gör ett litet
formulär till en välformulerad fråga, och ställer in det researchläge som passar den.

De inbyggda täcker en djupgående rapport, en jämförelse sida vid sida, en förklaring anpassad till
en mottagare du väljer, en nyhetssammanställning och — där bildgenerering finns — en teckning. Fyll
i fälten märkta \`*\`, tryck **Använd mall**, så hamnar den färdiga texten i meddelanderutan där du
fortfarande kan ändra den innan du skickar.

**Egna mallar.** *Skapa egen mall* längst ner i mallväljaren öppnar **Promptstudion**. Skriv en
prompt, märk de utbytbara delarna med dubbla klamrar — \`Förklara {{begrepp}} för en {{mottagare}}\`
— så gör studion ett fält av var och en. Fyll i testvärden, tryck **▶ Kör**, se vad som kommer
tillbaka, justera, och spara när den beter sig. Sparade mallar dyker upp i mallväljaren under
**Egna**, och kan ändras eller tas bort där.

**Recept.** I studions avsnitt *Recept* lägger du till **instruktionsanteckningar** (en stilguide,
en arbetsgång), **exempel** vars form ska efterliknas och samlingar att läsa. Mallen blir då ett
recept: när du väljer den visas en *Recept*-etikett i meddelanderutan, och varje meddelande i
chatten följer receptet tills du tar bort etiketten. Anteckningarna fungerar som instruktioner bara
på det här sättet — aldrig när en sökning råkar hitta dem. En anteckning du inte har granskat får en
varning bredvid etiketten.`,
  },

  images: {
    title: 'Bilder',
    summary: 'Skapa och ändra bilder, där installationen har stöd för det.',
    body: `Har installationen bildgenerering påslagen dyker ett fjärde läge upp bredvid de andra —
**bild**. Välj det och beskriv vad du vill ha: *"rita ett berglandskap i solnedgång"*.

Assistenten kan söka på nätet först när ämnet är obekant för den, så att bilden bygger på något
verkligt. Gör den det säger den det på en rad ovanför bilden och listar vad den läst.

**Ändra en bild.** Be om en ändring så ritas den senaste bilden om: *"låt det regna"*, *"gör vargen
grå"*. En ändring ärver inställningarna från bilden den utgår från, så du behöver inte upprepa dem.
Färgbyten kräver en större ändring än det låter — kommer en omfärgning tillbaka halvgjord, be
bestämdare eller ange en styrka: *"gör om den med styrka 0.6"*.

**Upprepa ett resultat.** Varje bild ritas från ett slumpmässigt **frö**, så samma fråga två gånger
ger två olika bilder. Säg *"använd frö 12345"* för att låsa det, och ändra sedan en sak i din
beskrivning — skillnaden du ser är den ändring du gjorde.

Färdiga bilder har en **Ladda ner PNG**-länk och är märkta *AI-genererad*. Om märkningen också ska
ritas in i den nedladdade filen bestämmer du under Inställningar.`,
  },

  privacy: {
    title: 'Hålla saker privata',
    summary: 'Tre skyddsnivåer: moln, lokalt, låst — och konfidentiellt innehåll.',
    body: `Allt du skriver, laddar upp och får tillbaka lagras på den här maskinen. Men när assistenten har läst
ett dokument är allt den kan skicka utåt en väg för dokumentet att läcka — och ett dokument kan
*innehålla instruktioner* som modellen följer.

Det finns tre skyddsnivåer:

- **En molnmodell** — bara om en administratör har gett dig tillgång och du väljer en. Leverantören
  får hela prompten: din fråga, samtalet och eventuella utdrag ur dokument. Du bekräftar det en gång,
  och svaret säger vart det skickades.
- **Lokala modeller (förval)** — inget går till en modelleverantör, men webbsökningar och hämtade
  sidor kan bära ord ur dina dokument. Förfrågningar som ser ut att göra det hålls kvar tills du
  godkänner dem. Det är upptäckt, och den kan luras.
- **Låst** — ingen webbsökning, sidhämtning, bildgenerering eller molnmodell alls. Vägarna ut finns
  inte, så ingenting behöver bedömas.

**Två sätt att låsa.**
- Ett **låst utrymme** (hänglås): alla chattar i det är låsta. Lås det innan något finns i det; när
  det har en chatt eller ett minne går det inte att låsa upp, och dess chattar kan bara flyttas till
  ett annat låst utrymme.
- **Konfidentiellt innehåll** (ögonikonen på en samling, eller på en resurs sida): bara låsta chattar
  får läsa det. Att välja en konfidentiell samling eller bifoga en konfidentiell anteckning låser
  chatten för gott, efter en fråga; chattens banner säger vad som låste den. Olåsta chattar utesluter
  konfidentiella dokument, och sidfoten säger det. Markeringen kan tas bort när som helst; låsta
  chattar förblir låsta.

**Ett dokument för bara en chatt:** bifoga det med gemet i en låst chatt i stället för att lägga det i
ditt bibliotek.

**En gräns värd att känna till.** Ett lås tar bort modellens verktyg; det ändrar inte var modellen
körs. Om installationens egna modeller ligger någon annanstans når dokumenten dem ändå.`,
  },

  settings: {
    title: 'Inställningar',
    summary: 'De få inställningar som faktiskt är värda att ändra.',
    body: `**Inställningar**, längst ner i sidopanelen. Allt är per användare. De som förändrar din
vardag:

- **Egen systemprompt** — stående instruktioner som läggs till varje fråga. *"Svara på svenska"*,
  *"fatta dig kort"*, *"visa alltid hur du resonerar"*.
- **Om dig** — avstängt från början. En kort lista med fakta som gäller i *varje* chatt, med eller
  utan utrymme: hur du vill ha svaren skrivna, vad du arbetar med, varaktiga förutsättningar.
  Ingenting skrivs automatiskt; du skriver det, godtar ett förslag eller låter assistenten föreslå
  ett. **Föreslå utifrån mina chattar** läser dina senaste samtal och föreslår några, som du godtar
  en i taget.
- **Språk** — gränssnittets språk. Det påverkar inte vilket språk du får svar på: assistenten
  svarar på det språk du frågade på.
- **Visa sökprocessen** — visar sökningarna och utdragen ovanför svaret, hopfällt. Värt att slå på
  en gång för att se hur ett svar kom till.
- **Tema** — Mörkt, Ljust eller E-ink (svart på vitt, utan animationer) för läsplattor med e-papper; grafer och märken behåller några färger som även fungerar i gråskala.
- **Textstorlek** och **Tidszon** — den senare avgör vad *02:00* betyder för en bevakning.
- **Export** — laddar ner dina anteckningar och resurser som ett Obsidian-valv, med länkar och
  taggar kvar; kryssa i rutan för att även få med chattar och skapade bilder.
- **Lösenord** — att byta det loggar ut dina andra enheter och behåller den här.`,
  },
} satisfies Guide
