---
layout: guide
---

## Prerequisites <a class="toc" id="prerequisites" href="#prerequisites"></a>

Botpress runs on [Node.js](https://nodejs.org) (version >= 8.2). You must also have either [npm](https://www.npmjs.com) or [yarn](https://yarnpkg.com) installed.

## Installing the CLI <a class="toc" id="install" href="#install"></a>

Using the Botpress CLI is the easiest and recommended way of creating bots on Botpress.

```bash
# using npm
npm install -g botpress

# using yarn
yarn global add botpress
```

> **Note:**️ Make sure you install the CLI as a global dependency, with the `-g` npm flag or the `global` command using yarn.

> If you have a permission error at this stage, consider running the command as an administrator.

Running the following command should return the version of the CLI tool letting you know that everything installed correctly:

```bash
# long version
botpress --version

# shortcut
bp --version
```

## Creating your first bot <a class="toc" id="toc-creating-a-new-bot" href="#toc-creating-a-new-bot"></a>

Create a new directory for your new bot called `my-first-bot` then run the following command in this folder:

```bash
botpress init
```

This will ask you a couple of questions and bootstrap a new bot from the default bot template. Once that is done, you need to install the dependencies:

```bash
# using npm
npm install

# using yarn
yarn install
```

The dependencies might take a while to install the first time. Should you get an error, please search our [forum](https://help.botpress.io/) to see if anyone has had a similar problem and ask for help from the community. If it is an issue in the codebase, head over to GitHub to [open an issue](https://github.com/botpress/botpress/issues/new).

### Starting the bot <a class="toc" id="toc-starting-bot" href="#toc-starting-bot"></a>

Once the dependencies are installed, start the bot using:

```bash
# using npm
npm start

# using yarn
yarn start
```

And that's it! This will start the bot on your computer and provide you with a graphical interface at [https://localhost:3000/](https://localhost:3000/), so that you can customize and speak to your bot.

## Next steps <a class="toc" id="toc-next-steps" href="#toc-next-steps"></a>

Your bot currently doesn't do much. In the next section, we will learn the basic components of a Botpress bot, to better prepare you to create your first customized bot!
