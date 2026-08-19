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

- **Chattar** — allt du har frågat.
- **Resurser** — dokument, webbsidor och anteckningar som assistenten kan använda.
- **Arbetsytor** — utrymmen, som grupperar chattar och minns vad som sagts i dem, och samlingar,
  som grupperar resurser.
- **Bevakningar** — frågor som ställer sig själva enligt ett schema.

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
    summary: 'Avgränsa sökningen till nyheter eller vetenskap, och svara utifrån en samling.',
    body: `Knappen till höger om lägena avgör *varifrån* ett svar får hämta. Den är valfri — rör du
den inte används allt.

**Sökkategorier** gäller i balanserat och grundligt läge: **nyheter**, **vetenskap**,
**diskussioner** och **teknik**. Välj en eller flera för att begränsa webbsökningen till den sortens
sidor. *nyheter+vetenskap* söker i båda. Användbart när en vanlig sökning envisas med fel sorts
träffar — produktsidor när du ville ha forskning, till exempel.

**Samlingar** ligger under samma knapp. Kryssar du i en läser den omgången också ur resurserna i
den, oavsett vilken chatt du är i. Utdrag ur en samling får hänvisningarna \`[C1]\`, \`[C2]\` så att
du alltid ser vilken hylla svaret kommer från.

Båda valen gäller **bara nästa meddelande** och lyser tills du tar bort dem — de sparas inte på
chatten. Ingenting är valt från början, så när knappen säger *Alla kategorier* betyder det alla
*kategorier*, inte alla samlingar.`,
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

En anteckning når ett samtal på två sätt: automatiskt som utdrag, likt vilken resurs som helst,
eller hel genom anteckningsikonen bredvid gemet. Bara anteckningar kan bifogas så — en fils text
lagras som överlappande utdrag, så att skicka den hel vore att upprepa sig; gemet täcker redan det
fallet.

Använd en anteckning för det du vill ha bevarat ord för ord: en beställning, en kravlista, ett
beslut och skälet till det.`,
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
    body: `En **samling** innehåller resurser och ingenting annat. Inga chattar, inget minne, inget
lås. Den finns för referensmaterial som inte hör till något särskilt projekt — där det vore att
hitta på ett projekt som inte finns bara för att kunna lägga undan materialet.

Samlingar och utrymmen ligger båda under **Arbetsytor**, i två märkta avdelningar. En resurs taggas
till en samling precis som till ett utrymme.

**Använda en.** Kryssa i den under meddelanderutan så läser den frågan också ur dess resurser —
oavsett om chatten ligger i ett utrymme eller inte. Krysset sitter kvar tills du tar bort det och
sparas inte på chatten, så det kostar inte mer att ändra än researchläget bredvid.

**Göra om den till ett utrymme.** Visar sig samlingen vara ett projekt ändå kan du befordra den
från dess egen panel, och den behåller alla resurser. Det går bara åt ett håll: ett utrymme som
redan har chattar och minnen går inte att läsa som en samling.`,
  },

  monitors: {
    title: 'Bevakningar',
    summary: 'En fråga som ställer sig själv enligt ett schema.',
    body: `En **bevakning** kör om en fråga av sig själv — var sjätte timme, dagligen, veckovis —
och sparar varje körning som en vanlig chatt du kan öppna, läsa och fortsätta i.

**Skapa en.** *Ny bevakning* i vyn Bevakningar. Ge den en fråga, ett researchläge och ett
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
**Egna**, och kan ändras eller tas bort där.`,
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
    summary: 'Låsta utrymmen, och hur du analyserar ett dokument som inte får lämna maskinen.',
    body: `Allt du skriver, laddar upp och får tillbaka lagras på den här maskinen. Men när
assistenten väl har läst ett dokument är allt den kan skicka utåt en väg för dokumentet att läcka —
och ett dokument kan *innehålla instruktioner* som modellen följer. Queriocity utgår från att det
den läser kan vara fientligt.

Ett **låst utrymme** löser det genom att ta bort förmågan i stället för att övervaka den. Chattar i
ett låst utrymme får ingen webbsökning, ingen sidhämtning och ingen bildgenerering. Det finns inget
att bedöma, alltså inget att göra fel.

**Så analyserar du ett känsligt dokument:**

1. **Skapa ett utrymme och lås det först**, innan något ligger i det.
2. **Starta en ny chatt inne i utrymmet.**
3. **Bifoga dokumentet med gemet** — inte till biblioteket.

Steg 3 är lika viktigt som de andra. En fil i **biblioteket** kan hittas från *varenda* chatt du
äger, även sådana med nätåtkomst. En bilaga hamnar aldrig i biblioteket och finns därför bara i det
låsta samtalet.

**Låsning går nästan bara åt ett håll.** Ett tomt utrymme kan låsas upp fritt; ett som innehåller
en chatt eller ett minne kan det inte, eftersom upplåsningen skulle ge nätåtkomst åt allt som
samlats in under löftet att det inte fanns någon. Chattar i ett låst utrymme kan bara flyttas till
ett annat låst utrymme, och raderar du ett låst utrymme raderas dess chattar i stället för att
släppas fria.

**En gräns värd att känna till.** Låsning tar bort modellens verktyg; den ändrar inte var modellen
kör. Använder installationen en molnmodell i stället för en lokal skickas ditt dokument dit redan i
första anropet, innan något verktyg hunnit finnas.`,
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
- **Textstorlek** och **Tidszon** — den senare avgör vad *02:00* betyder för en bevakning.
- **Lösenord** — att byta det loggar ut dina andra enheter och behåller den här.`,
  },
} satisfies Guide
