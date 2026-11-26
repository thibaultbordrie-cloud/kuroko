# Kuroko 黒子

**[Play / Jouer / 遊ぶ / 遊玩](https://thibaultbordrie-cloud.github.io/kuroko/)** · [English](#english) · [Français](#français) · [日本語](#日本語) · [繁體中文](#繁體中文)

A narrative spy game engine that runs on a phone, offline, with nothing sent anywhere. Stories come as content packs: plain-text data that the engine reads, checks and plays, and never executes.

```
packs/*.txt ──parse──▶ Pack ──validate (static + 400 random games)──▶ seal ──▶ .kuroko file
                                                                                  │
phone ◀── offline web app (service worker, IndexedDB) ◀── import, checksum, replayable save
```

## English

**What it does**

- **Scenes with conditions.** Each scene says when it can happen (`quand: tension >= 3 et non vu.quai`) and ends on choices that change variables, jump to a scene, schedule one for later, or end the story.
- **A procedural director.** It picks the next scene among those allowed, follows a tension curve that climbs and breathes, and avoids repeating the same place or point of view.
- **2d6 rolls** with three outcomes (10+, 7–9, 6−). The exact odds are shown before the player commits.
- **Character creation.** A pack can ask for a first name, a gender, who the character is drawn to, an origin, a flaw and points to share between traits. The text follows the choices (`{?fem:arrivée|arrivé}`, `{moi}`), some characters change with them, and the traits add to the dice.
- **A drawn, living setting.** Each scene opens on a plate painted in code for its kind of place (street, train, room, port, river, shrine, high floor, bath, office), with rain and flickering neon, and an optional sound bed made with Web Audio. Messages show as a phone, files as stamped dossiers, logs as a terminal. Nothing is downloaded.
- **Lines and veils**, a safety tool from tabletop role-playing: per theme, the player chooses *shown*, *veiled* (it happens off screen) or *line* (never happens). The validator checks that refusing any theme never leaves a game stuck.
- **Saves are a seed plus the list of choices.** Loading replays them, so an edited save is refused.
- **Sealed packs.** A pack file is compressed with a SHA-256 checksum: opening it shows nothing of the story, and a changed byte is refused.
- **An infiltration prototype** (`infiltration.html`): turn-based stealth on generated buildings, each proven solvable unseen by a breadth-first solver before it is offered.

**Security**

- Pack conditions are parsed and evaluated by a small interpreter: no `eval`, no `Function`, no markup. Text from packs is only ever set with `textContent`.
- The page loads no external resource. Its Content Security Policy allows only its own inline script and style, by hash.
- Packs and saves stay in the browser's IndexedDB on the device.

**Build and test**

```sh
npm ci
npm run typecheck
npm test                 # unit and property tests (node:test)
npm run build            # dist/site: the offline web app
npm run check-pack -- packs/dernier-train.txt
```

**Writing a pack**

```
@pack
titre: Dernier train
debut: quai

@scene quai
lieu: quai
---
The last train comes in without a sound.
> Get on at the front
  effets: calme += 1
> Ask what is in the bag
  jet: calme
  10+: savoir = 1
  7-9: savoir = 1; soupcon += 1
  6-: soupcon += 2
```

The pack language uses French keywords. `packs/dernier-train.txt` is a complete short example.

## Français

Un moteur de jeu d'espionnage narratif qui tourne sur téléphone, hors ligne, sans rien envoyer nulle part. Les histoires arrivent en packs de contenu : des données en texte que le moteur lit, vérifie et joue, sans jamais les exécuter.

- **Scènes à conditions**, choix, conséquences immédiates ou différées, fins multiples.
- **Un meneur procédural** qui choisit la scène suivante selon une courbe de tension et la variété des lieux.
- **Jets 2d6** à trois issues, chances exactes affichées avant le choix.
- **Création de personnage** : prénom, genre, attirance, origine, faille et points de talents ; le texte s'accorde et les talents comptent aux dés.
- **Un décor dessiné et vivant** pour chaque lieu (pluie, néons, ambiance sonore en option), messages en téléphone, dossiers tamponnés. Rien n'est téléchargé.
- **Lignes et voiles** par thème ; le vérificateur prouve qu'aucun refus de thème ne bloque une partie.
- **Sauvegarde rejouable** (graine + choix) : une sauvegarde modifiée est refusée.
- **Packs scellés** (compression + SHA-256), stockés sur l'appareil seulement.
- Aucune ressource externe, CSP stricte par empreinte, aucun `eval`.

Commandes : voir la section anglaise.

## 日本語

スマートフォンでオフライン動作する、物語型スパイゲームのエンジンです。データは端末の外に送信されません。物語は「コンテンツパック」として読み込まれます。パックはテキストのデータであり、エンジンが解析・検証・再生しますが、コードとして実行されることはありません。

- **条件付きシーン**：選択、即時または遅延する結果、複数のエンディング。
- **手続き的ディレクター**：緊張度の曲線と場所の変化に基づいて次のシーンを選びます。
- **2d6 判定**：3段階の結果。選ぶ前に正確な確率を表示します。
- **キャラクター作成**：名前、性別、惹かれる相手、出自、弱点、能力値の配分。文章が選択に合わせて変化し、能力値は判定に加算されます。
- **コードで描かれる舞台**：場所ごとの背景（雨、ネオン、任意の環境音）。メッセージはスマートフォン風、資料は押印された書類として表示。外部からは何も読み込みません。
- **ライン＆ヴェール**：テーマごとに「表示」「伏せる」「出さない」を選べます。どのテーマを拒否してもゲームが詰まらないことを検証ツールが確認します。
- **再生可能なセーブ**（シード＋選択の記録）：改ざんされたセーブは読み込みを拒否します。
- **封印されたパック**（圧縮＋SHA-256）、端末内にのみ保存。
- 外部リソースなし、ハッシュによる厳格な CSP、`eval` 不使用。

## 繁體中文

一個可在手機上離線執行的敘事型諜報遊戲引擎，不會向外傳送任何資料。故事以「內容包」的形式載入：內容包是純文字資料，由引擎解析、驗證並播放，絕不會被當作程式碼執行。

- **條件式場景**：選項、立即或延後的後果、多重結局。
- **程序化導演**：依照緊張度曲線與場景變化挑選下一個場景。
- **2d6 擲骰**：三種結果，選擇前即顯示精確機率。
- **角色創建**：名字、性別、喜歡的對象、出身、弱點與能力點數分配。文字會隨選擇變化，能力值會加到擲骰上。
- **以程式繪製的場景**：每個地點都有背景（雨、霓虹、可選的環境音），訊息以手機樣式呈現，檔案以蓋章的卷宗呈現。不下載任何外部資源。
- **界線與帷幕**：每個主題可選擇「呈現」、「帶過」或「不出現」；驗證工具確認拒絕任何主題都不會讓遊戲卡住。
- **可重播的存檔**（種子＋選擇紀錄）：被竄改的存檔會被拒絕。
- **封裝的內容包**（壓縮＋SHA-256），只存放在裝置上。
- 不載入外部資源，以雜湊值設定嚴格的 CSP，不使用 `eval`。

## License

MIT
