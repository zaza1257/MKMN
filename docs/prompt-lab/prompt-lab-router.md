---
title: The router's closed questions, on hard requests
runs: 1
max_tokens: 12
greedy: on
thinking: off
system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in.
---

# The router's closed questions, on hard requests

Every decision about a request is a closed question put to the router (`Q` in `src/core/router.ts`), never read from the words of the message. This series asks the same questions, in the same form (`yesNoPrompt`, `choicePrompt`), of requests that small models get wrong: a document that says "make", an Excel file that is not a program, a game question that is not a game, a typo, an exercise with figures.
Each prompt is one question about one request; the ideal is the right word. The score of a model is how many it gets right: read the table by question (program, sheet, word, site, calculator, exercise, web, identity, file) to see which question a model cannot answer, and change the wording of that question in `Q` and run again. The questions marked `file` use another system message (see the first of them: set it by hand in the options if the page asks for it) and pick one word of a list. The `identity` prompts pin the new `Q.identity`: an identity question must be yes, and a build that mentions assistants, robots or names must stay no.
The `confirm` prompts pin the new `Q.programConfirm`, the confirming question of the build gate (a chat-model yes on `program`, the router not saying yes, is asked once more in other words): the recorded recall and knowledge questions that the 4B chat model turned into builds must stay no, and a build request ("make tetris", Arabic "اصنع لعبة") must still be yes.
Run it with the router model (Qwen3-0.6B) and with bigger ones (Qwen3.5-2B, 4B) to see what the router costs in accuracy against how long it takes (the time of each answer is in the table).


## program-01 short

Request: """make tetris"""
Question: Does it ask to build, write or change something that RUNS: a program, game, app, tool or web page, or say that something in one does not work or looks wrong? (Answer no for a chat, a question, an explanation, a chart, a spreadsheet, an Excel or Word file, a text document or a thanks.)
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: make me a tic-tac-toe game -> yes; I would like a stopwatch app with lap times -> yes; the score does not update after a level, fix it -> yes; add a dark mode switch to the page -> yes; make me a chess game I can play against the computer -> yes; أريد لعبة إكس-أو ألعبها ضد الكمبيوتر -> yes; explain the difference between a list and a tuple in python -> no; write an email to move my appointment -> no; make me an excel table of my groceries -> no; what is the capital of Canada? -> no; what was the score of yesterday's game? -> no.
max_tokens: 12


## program-02 long game

Request: """I want a 2D game like the first Super Mario Bros. You play a little character who runs and jumps"""
Question: Does it ask to build, write or change something that RUNS: a program, game, app, tool or web page, or say that something in one does not work or looks wrong? (Answer no for a chat, a question, an explanation, a chart, a spreadsheet, an Excel or Word file, a text document or a thanks.)
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: make me a tic-tac-toe game -> yes; I would like a stopwatch app with lap times -> yes; the score does not update after a level, fix it -> yes; add a dark mode switch to the page -> yes; make me a chess game I can play against the computer -> yes; أريد لعبة إكس-أو ألعبها ضد الكمبيوتر -> yes; explain the difference between a list and a tuple in python -> no; write an email to move my appointment -> no; make me an excel table of my groceries -> no; what is the capital of Canada? -> no; what was the score of yesterday's game? -> no.
max_tokens: 12


## program-06 app

Request: """a to-do app that saves in the browser"""
Question: Does it ask to build, write or change something that RUNS: a program, game, app, tool or web page, or say that something in one does not work or looks wrong? (Answer no for a chat, a question, an explanation, a chart, a spreadsheet, an Excel or Word file, a text document or a thanks.)
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: make me a tic-tac-toe game -> yes; I would like a stopwatch app with lap times -> yes; the score does not update after a level, fix it -> yes; add a dark mode switch to the page -> yes; make me a chess game I can play against the computer -> yes; أريد لعبة إكس-أو ألعبها ضد الكمبيوتر -> yes; explain the difference between a list and a tuple in python -> no; write an email to move my appointment -> no; make me an excel table of my groceries -> no; what is the capital of Canada? -> no; what was the score of yesterday's game? -> no.
max_tokens: 12


## program-07 web page

Request: """a landing page for my bakery"""
Question: Does it ask to build, write or change something that RUNS: a program, game, app, tool or web page, or say that something in one does not work or looks wrong? (Answer no for a chat, a question, an explanation, a chart, a spreadsheet, an Excel or Word file, a text document or a thanks.)
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: make me a tic-tac-toe game -> yes; I would like a stopwatch app with lap times -> yes; the score does not update after a level, fix it -> yes; add a dark mode switch to the page -> yes; make me a chess game I can play against the computer -> yes; أريد لعبة إكس-أو ألعبها ضد الكمبيوتر -> yes; explain the difference between a list and a tuple in python -> no; write an email to move my appointment -> no; make me an excel table of my groceries -> no; what is the capital of Canada? -> no; what was the score of yesterday's game? -> no.
max_tokens: 12


## program-10 document

Request: """do some research on american healthcare and make a research doc"""
Question: Does it ask to build, write or change something that RUNS: a program, game, app, tool or web page, or say that something in one does not work or looks wrong? (Answer no for a chat, a question, an explanation, a chart, a spreadsheet, an Excel or Word file, a text document or a thanks.)
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: make me a tic-tac-toe game -> yes; I would like a stopwatch app with lap times -> yes; the score does not update after a level, fix it -> yes; add a dark mode switch to the page -> yes; make me a chess game I can play against the computer -> yes; أريد لعبة إكس-أو ألعبها ضد الكمبيوتر -> yes; explain the difference between a list and a tuple in python -> no; write an email to move my appointment -> no; make me an excel table of my groceries -> no; what is the capital of Canada? -> no; what was the score of yesterday's game? -> no.
max_tokens: 12


## program-11 joke

Request: """tell me a joke about games"""
Question: Does it ask to build, write or change something that RUNS: a program, game, app, tool or web page, or say that something in one does not work or looks wrong? (Answer no for a chat, a question, an explanation, a chart, a spreadsheet, an Excel or Word file, a text document or a thanks.)
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: make me a tic-tac-toe game -> yes; I would like a stopwatch app with lap times -> yes; the score does not update after a level, fix it -> yes; add a dark mode switch to the page -> yes; make me a chess game I can play against the computer -> yes; أريد لعبة إكس-أو ألعبها ضد الكمبيوتر -> yes; explain the difference between a list and a tuple in python -> no; write an email to move my appointment -> no; make me an excel table of my groceries -> no; what is the capital of Canada? -> no; what was the score of yesterday's game? -> no.
max_tokens: 12


## program-12 question

Request: """what is the best game of 2020?"""
Question: Does it ask to build, write or change something that RUNS: a program, game, app, tool or web page, or say that something in one does not work or looks wrong? (Answer no for a chat, a question, an explanation, a chart, a spreadsheet, an Excel or Word file, a text document or a thanks.)
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: make me a tic-tac-toe game -> yes; I would like a stopwatch app with lap times -> yes; the score does not update after a level, fix it -> yes; add a dark mode switch to the page -> yes; make me a chess game I can play against the computer -> yes; أريد لعبة إكس-أو ألعبها ضد الكمبيوتر -> yes; explain the difference between a list and a tuple in python -> no; write an email to move my appointment -> no; make me an excel table of my groceries -> no; what is the capital of Canada? -> no; what was the score of yesterday's game? -> no.
max_tokens: 12


## program-13 question about making

Request: """how do I make a game with unity?"""
Question: Does it ask to build, write or change something that RUNS: a program, game, app, tool or web page, or say that something in one does not work or looks wrong? (Answer no for a chat, a question, an explanation, a chart, a spreadsheet, an Excel or Word file, a text document or a thanks.)
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: make me a tic-tac-toe game -> yes; I would like a stopwatch app with lap times -> yes; the score does not update after a level, fix it -> yes; add a dark mode switch to the page -> yes; make me a chess game I can play against the computer -> yes; أريد لعبة إكس-أو ألعبها ضد الكمبيوتر -> yes; explain the difference between a list and a tuple in python -> no; write an email to move my appointment -> no; make me an excel table of my groceries -> no; what is the capital of Canada? -> no; what was the score of yesterday's game? -> no.
max_tokens: 12


## program-16 chart

Request: """make me a chart of GDP by country"""
Question: Does it ask to build, write or change something that RUNS: a program, game, app, tool or web page, or say that something in one does not work or looks wrong? (Answer no for a chat, a question, an explanation, a chart, a spreadsheet, an Excel or Word file, a text document or a thanks.)
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: make me a tic-tac-toe game -> yes; I would like a stopwatch app with lap times -> yes; the score does not update after a level, fix it -> yes; add a dark mode switch to the page -> yes; make me a chess game I can play against the computer -> yes; أريد لعبة إكس-أو ألعبها ضد الكمبيوتر -> yes; explain the difference between a list and a tuple in python -> no; write an email to move my appointment -> no; make me an excel table of my groceries -> no; what is the capital of Canada? -> no; what was the score of yesterday's game? -> no.
max_tokens: 12


## program-18 letter

Request: """write a cover letter for a barista job"""
Question: Does it ask to build, write or change something that RUNS: a program, game, app, tool or web page, or say that something in one does not work or looks wrong? (Answer no for a chat, a question, an explanation, a chart, a spreadsheet, an Excel or Word file, a text document or a thanks.)
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: make me a tic-tac-toe game -> yes; I would like a stopwatch app with lap times -> yes; the score does not update after a level, fix it -> yes; add a dark mode switch to the page -> yes; make me a chess game I can play against the computer -> yes; أريد لعبة إكس-أو ألعبها ضد الكمبيوتر -> yes; explain the difference between a list and a tuple in python -> no; write an email to move my appointment -> no; make me an excel table of my groceries -> no; what is the capital of Canada? -> no; what was the score of yesterday's game? -> no.
max_tokens: 12


## program-19 thanks

Request: """merci beaucoup !"""
Question: Does it ask to build, write or change something that RUNS: a program, game, app, tool or web page, or say that something in one does not work or looks wrong? (Answer no for a chat, a question, an explanation, a chart, a spreadsheet, an Excel or Word file, a text document or a thanks.)
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: make me a tic-tac-toe game -> yes; I would like a stopwatch app with lap times -> yes; the score does not update after a level, fix it -> yes; add a dark mode switch to the page -> yes; make me a chess game I can play against the computer -> yes; أريد لعبة إكس-أو ألعبها ضد الكمبيوتر -> yes; explain the difference between a list and a tuple in python -> no; write an email to move my appointment -> no; make me an excel table of my groceries -> no; what is the capital of Canada? -> no; what was the score of yesterday's game? -> no.
max_tokens: 12


## program-22 names

Request: """what's a good name for my game studio"""
Question: Does it ask to build, write or change something that RUNS: a program, game, app, tool or web page, or say that something in one does not work or looks wrong? (Answer no for a chat, a question, an explanation, a chart, a spreadsheet, an Excel or Word file, a text document or a thanks.)
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: make me a tic-tac-toe game -> yes; I would like a stopwatch app with lap times -> yes; the score does not update after a level, fix it -> yes; add a dark mode switch to the page -> yes; make me a chess game I can play against the computer -> yes; أريد لعبة إكس-أو ألعبها ضد الكمبيوتر -> yes; explain the difference between a list and a tuple in python -> no; write an email to move my appointment -> no; make me an excel table of my groceries -> no; what is the capital of Canada? -> no; what was the score of yesterday's game? -> no.
max_tokens: 12


## sheet-02 empty sheet

Request: """an empty accounting journal I can use in Excel"""
Question: Does it ask for an Excel spreadsheet, a table of figures, or a sheet to fill in or to calculate in?
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: a workbook to track my employees' hours -> yes; build me a spreadsheet to compare three loan offers -> yes; a monthly budget in excel -> yes; write a speech for my sister's wedding -> no; what is the difference between SUM and SUMIF? -> no; make a site for my association -> no.
max_tokens: 12


## sheet-04 budget

Request: """make a monthly budget spreadsheet"""
Question: Does it ask for an Excel spreadsheet, a table of figures, or a sheet to fill in or to calculate in?
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: a workbook to track my employees' hours -> yes; build me a spreadsheet to compare three loan offers -> yes; a monthly budget in excel -> yes; write a speech for my sister's wedding -> no; what is the difference between SUM and SUMIF? -> no; make a site for my association -> no.
max_tokens: 12


## sheet-06 table

Request: """un tableau de suivi de stock"""
Question: Does it ask for an Excel spreadsheet, a table of figures, or a sheet to fill in or to calculate in?
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: a workbook to track my employees' hours -> yes; build me a spreadsheet to compare three loan offers -> yes; a monthly budget in excel -> yes; write a speech for my sister's wedding -> no; what is the difference between SUM and SUMIF? -> no; make a site for my association -> no.
max_tokens: 12


## sheet-07 letter

Request: """write a letter to my landlord"""
Question: Does it ask for an Excel spreadsheet, a table of figures, or a sheet to fill in or to calculate in?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: a workbook to track my employees' hours -> yes; build me a spreadsheet to compare three loan offers -> yes; a monthly budget in excel -> yes; write a speech for my sister's wedding -> no; what is the difference between SUM and SUMIF? -> no; make a site for my association -> no.
max_tokens: 12


## sheet-08 game

Request: """make a snake game"""
Question: Does it ask for an Excel spreadsheet, a table of figures, or a sheet to fill in or to calculate in?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: a workbook to track my employees' hours -> yes; build me a spreadsheet to compare three loan offers -> yes; a monthly budget in excel -> yes; write a speech for my sister's wedding -> no; what is the difference between SUM and SUMIF? -> no; make a site for my association -> no.
max_tokens: 12


## sheet-09 question about Excel

Request: """explain what a pivot table is"""
Question: Does it ask for an Excel spreadsheet, a table of figures, or a sheet to fill in or to calculate in?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: a workbook to track my employees' hours -> yes; build me a spreadsheet to compare three loan offers -> yes; a monthly budget in excel -> yes; write a speech for my sister's wedding -> no; what is the difference between SUM and SUMIF? -> no; make a site for my association -> no.
max_tokens: 12


## sheet-10 question

Request: """what's the best spreadsheet software?"""
Question: Does it ask for an Excel spreadsheet, a table of figures, or a sheet to fill in or to calculate in?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: a workbook to track my employees' hours -> yes; build me a spreadsheet to compare three loan offers -> yes; a monthly budget in excel -> yes; write a speech for my sister's wedding -> no; what is the difference between SUM and SUMIF? -> no; make a site for my association -> no.
max_tokens: 12


## word-01 letter

Request: """write a cover letter for a barista job"""
Question: Does it ask for a written document to be made (a letter, a report, a CV, minutes, a contract, a research document)?
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: write a resignation letter -> yes; make a project proposal for a mobile app -> yes; do some research on electric cars and make a research doc -> yes; translate this sentence into Arabic -> no; my printer does not work, any idea? -> no; make a spreadsheet of my expenses -> no.
max_tokens: 12


## word-03 research doc

Request: """do some research on american healthcare and make a research doc"""
Question: Does it ask for a written document to be made (a letter, a report, a CV, minutes, a contract, a research document)?
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: write a resignation letter -> yes; make a project proposal for a mobile app -> yes; do some research on electric cars and make a research doc -> yes; translate this sentence into Arabic -> no; my printer does not work, any idea? -> no; make a spreadsheet of my expenses -> no.
max_tokens: 12


## word-05 contract

Request: """make a freelance contract for a web designer"""
Question: Does it ask for a written document to be made (a letter, a report, a CV, minutes, a contract, a research document)?
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: write a resignation letter -> yes; make a project proposal for a mobile app -> yes; do some research on electric cars and make a research doc -> yes; translate this sentence into Arabic -> no; my printer does not work, any idea? -> no; make a spreadsheet of my expenses -> no.
max_tokens: 12


## word-06 sheet

Request: """make me a budget in Excel"""
Question: Does it ask for a written document to be made (a letter, a report, a CV, minutes, a contract, a research document)?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: write a resignation letter -> yes; make a project proposal for a mobile app -> yes; do some research on electric cars and make a research doc -> yes; translate this sentence into Arabic -> no; my printer does not work, any idea? -> no; make a spreadsheet of my expenses -> no.
max_tokens: 12


## word-07 question

Request: """what is a CV for?"""
Question: Does it ask for a written document to be made (a letter, a report, a CV, minutes, a contract, a research document)?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: write a resignation letter -> yes; make a project proposal for a mobile app -> yes; do some research on electric cars and make a research doc -> yes; translate this sentence into Arabic -> no; my printer does not work, any idea? -> no; make a spreadsheet of my expenses -> no.
max_tokens: 12


## word-08 poem

Request: """write a poem about the sea"""
Question: Does it ask for a written document to be made (a letter, a report, a CV, minutes, a contract, a research document)?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: write a resignation letter -> yes; make a project proposal for a mobile app -> yes; do some research on electric cars and make a research doc -> yes; translate this sentence into Arabic -> no; my printer does not work, any idea? -> no; make a spreadsheet of my expenses -> no.
max_tokens: 12


## word-09 game

Request: """make tetris"""
Question: Does it ask for a written document to be made (a letter, a report, a CV, minutes, a contract, a research document)?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: write a resignation letter -> yes; make a project proposal for a mobile app -> yes; do some research on electric cars and make a research doc -> yes; translate this sentence into Arabic -> no; my printer does not work, any idea? -> no; make a spreadsheet of my expenses -> no.
max_tokens: 12


## word-10 greeting

Request: """bonjour"""
Question: Does it ask for a written document to be made (a letter, a report, a CV, minutes, a contract, a research document)?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: write a resignation letter -> yes; make a project proposal for a mobile app -> yes; do some research on electric cars and make a research doc -> yes; translate this sentence into Arabic -> no; my printer does not work, any idea? -> no; make a spreadsheet of my expenses -> no.
max_tokens: 12


## site-01 landing

Request: """a landing page for my bakery"""
Question: Does it ask for a website, a landing page or a web page to show to people?
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: a one-page site for my yoga classes -> yes; make a site to present my association -> yes; a portfolio page for a photographer -> yes; explain what DNS is -> no; write the text of an about-us paragraph -> no; make a pong game -> no.
max_tokens: 12


## site-03 portfolio

Request: """portfolio website with a dark mode"""
Question: Does it ask for a website, a landing page or a web page to show to people?
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: a one-page site for my yoga classes -> yes; make a site to present my association -> yes; a portfolio page for a photographer -> yes; explain what DNS is -> no; write the text of an about-us paragraph -> no; make a pong game -> no.
max_tokens: 12


## site-04 question

Request: """how do I host a website for free?"""
Question: Does it ask for a website, a landing page or a web page to show to people?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: a one-page site for my yoga classes -> yes; make a site to present my association -> yes; a portfolio page for a photographer -> yes; explain what DNS is -> no; write the text of an about-us paragraph -> no; make a pong game -> no.
max_tokens: 12


## site-05 text

Request: """write a blog post about websites"""
Question: Does it ask for a website, a landing page or a web page to show to people?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: a one-page site for my yoga classes -> yes; make a site to present my association -> yes; a portfolio page for a photographer -> yes; explain what DNS is -> no; write the text of an about-us paragraph -> no; make a pong game -> no.
max_tokens: 12


## site-06 calculator

Request: """make a calculator"""
Question: Does it ask for a website, a landing page or a web page to show to people?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: a one-page site for my yoga classes -> yes; make a site to present my association -> yes; a portfolio page for a photographer -> yes; explain what DNS is -> no; write the text of an about-us paragraph -> no; make a pong game -> no.
max_tokens: 12


## calculator-01 converter

Request: """convertisseur euros dollars"""
Question: Does it ask for a small calculator, converter or simulator page with inputs and a result?
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: a tip calculator -> yes; a page that converts miles to kilometers -> yes; a car loan simulator -> yes; what is 45 times 12? -> no; make me a todo app -> no; make a repayment spreadsheet -> no.
max_tokens: 12


## calculator-02 calculator

Request: """BMI calculator"""
Question: Does it ask for a small calculator, converter or simulator page with inputs and a result?
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: a tip calculator -> yes; a page that converts miles to kilometers -> yes; a car loan simulator -> yes; what is 45 times 12? -> no; make me a todo app -> no; make a repayment spreadsheet -> no.
max_tokens: 12


## calculator-04 just compute

Request: """what's 15% of 80?"""
Question: Does it ask for a small calculator, converter or simulator page with inputs and a result?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: a tip calculator -> yes; a page that converts miles to kilometers -> yes; a car loan simulator -> yes; what is 45 times 12? -> no; make me a todo app -> no; make a repayment spreadsheet -> no.
max_tokens: 12


## calculator-05 sheet

Request: """make an Excel loan table"""
Question: Does it ask for a small calculator, converter or simulator page with inputs and a result?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: a tip calculator -> yes; a page that converts miles to kilometers -> yes; a car loan simulator -> yes; what is 45 times 12? -> no; make me a todo app -> no; make a repayment spreadsheet -> no.
max_tokens: 12


## calculator-06 game

Request: """snake game"""
Question: Does it ask for a small calculator, converter or simulator page with inputs and a result?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: a tip calculator -> yes; a page that converts miles to kilometers -> yes; a car loan simulator -> yes; what is 45 times 12? -> no; make me a todo app -> no; make a repayment spreadsheet -> no.
max_tokens: 12


## exercise-03 figures

Request: """calculate the VAT on 1200 at 20% in a sheet"""
Question: Does it give its own figures and ask for something to be worked out or answered from them (an exercise, a cost, a valuation), rather than an empty sheet or a general template?
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: I buy 12 items at 7.50 € with a 20 % discount, work out the total in a spreadsheet -> yes; Salary 3200, rent 900, food 400: work out what is left, in a sheet -> yes; make me a blank invoice -> no; explain how to work out a weighted average -> no; a template to track my hours -> no.
max_tokens: 12


## exercise-05 template

Request: """make an inventory template"""
Question: Does it give its own figures and ask for something to be worked out or answered from them (an exercise, a cost, a valuation), rather than an empty sheet or a general template?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: I buy 12 items at 7.50 € with a 20 % discount, work out the total in a spreadsheet -> yes; Salary 3200, rent 900, food 400: work out what is left, in a sheet -> yes; make me a blank invoice -> no; explain how to work out a weighted average -> no; a template to track my hours -> no.
max_tokens: 12


## exercise-08 no figures given

Request: """make a table of the planets"""
Question: Does it give its own figures and ask for something to be worked out or answered from them (an exercise, a cost, a valuation), rather than an empty sheet or a general template?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: I buy 12 items at 7.50 € with a 20 % discount, work out the total in a spreadsheet -> yes; Salary 3200, rent 900, food 400: work out what is left, in a sheet -> yes; make me a blank invoice -> no; explain how to work out a weighted average -> no; a template to track my hours -> no.
max_tokens: 12


## web-01 research

Request: """do some research on american healthcare"""
Question: Does answering it need recent facts, or looking something up on the web, that a model would not know by heart?
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: what's the weather in Paris this weekend? -> yes; latest news on the stock market -> yes; what is the price of gold today? -> yes; write a haiku about rain -> no; explain photosynthesis -> no; translate hello into Arabic -> no.
max_tokens: 12


## web-03 latest

Request: """what is the latest Qwen model release?"""
Question: Does answering it need recent facts, or looking something up on the web, that a model would not know by heart?
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: what's the weather in Paris this weekend? -> yes; latest news on the stock market -> yes; what is the price of gold today? -> yes; write a haiku about rain -> no; explain photosynthesis -> no; translate hello into Arabic -> no.
max_tokens: 12


## web-06 poem

Request: """write a poem about the sea"""
Question: Does answering it need recent facts, or looking something up on the web, that a model would not know by heart?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: what's the weather in Paris this weekend? -> yes; latest news on the stock market -> yes; what is the price of gold today? -> yes; write a haiku about rain -> no; explain photosynthesis -> no; translate hello into Arabic -> no.
max_tokens: 12


## web-07 game

Request: """make tetris"""
Question: Does answering it need recent facts, or looking something up on the web, that a model would not know by heart?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: what's the weather in Paris this weekend? -> yes; latest news on the stock market -> yes; what is the price of gold today? -> yes; write a haiku about rain -> no; explain photosynthesis -> no; translate hello into Arabic -> no.
max_tokens: 12


## web-08 explain

Request: """explain recursion with an example"""
Question: Does answering it need recent facts, or looking something up on the web, that a model would not know by heart?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: what's the weather in Paris this weekend? -> yes; latest news on the stock market -> yes; what is the price of gold today? -> yes; write a haiku about rain -> no; explain photosynthesis -> no; translate hello into Arabic -> no.
max_tokens: 12


## web-10 greeting

Request: """bonjour"""
Question: Does answering it need recent facts, or looking something up on the web, that a model would not know by heart?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: what's the weather in Paris this weekend? -> yes; latest news on the stock market -> yes; what is the price of gold today? -> yes; write a haiku about rain -> no; explain photosynthesis -> no; translate hello into Arabic -> no.
max_tokens: 12


## web-11 known fact

Request: """what is the capital of France?"""
Question: Does answering it need recent facts, or looking something up on the web, that a model would not know by heart?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: what's the weather in Paris this weekend? -> yes; latest news on the stock market -> yes; what is the price of gold today? -> yes; write a haiku about rain -> no; explain photosynthesis -> no; translate hello into Arabic -> no.
max_tokens: 12


## file-02 sheet

Request: """an empty accounting journal I can use in Excel"""
Question: What file does the request ask to be made? sheet = an Excel spreadsheet or a table of figures; document = a written document (a letter, a report, a CV, minutes, a contract, a research document); site = a website or a landing page; calculator = a small calculator, converter or simulator page; none = anything else (a program, a game, a chat, a question, a chart).
Answer with one of: sheet, document, site, calculator, none.
Answer:

### Checks

- starts: sheet

### Options

max_tokens: 12
system: You sort a request that a person sent to an assistant. Reply with one word from the list. Judge by what the request asks for, not by the language it is written in.


## file-04 document

Request: """do some research on american healthcare and make a research doc"""
Question: What file does the request ask to be made? sheet = an Excel spreadsheet or a table of figures; document = a written document (a letter, a report, a CV, minutes, a contract, a research document); site = a website or a landing page; calculator = a small calculator, converter or simulator page; none = anything else (a program, a game, a chat, a question, a chart).
Answer with one of: sheet, document, site, calculator, none.
Answer:

### Checks

- starts: document

### Options

max_tokens: 12
system: You sort a request that a person sent to an assistant. Reply with one word from the list. Judge by what the request asks for, not by the language it is written in.


## file-05 document

Request: """write a cover letter for a barista job"""
Question: What file does the request ask to be made? sheet = an Excel spreadsheet or a table of figures; document = a written document (a letter, a report, a CV, minutes, a contract, a research document); site = a website or a landing page; calculator = a small calculator, converter or simulator page; none = anything else (a program, a game, a chat, a question, a chart).
Answer with one of: sheet, document, site, calculator, none.
Answer:

### Checks

- starts: document

### Options

max_tokens: 12
system: You sort a request that a person sent to an assistant. Reply with one word from the list. Judge by what the request asks for, not by the language it is written in.


## file-08 site

Request: """a landing page for my bakery"""
Question: What file does the request ask to be made? sheet = an Excel spreadsheet or a table of figures; document = a written document (a letter, a report, a CV, minutes, a contract, a research document); site = a website or a landing page; calculator = a small calculator, converter or simulator page; none = anything else (a program, a game, a chat, a question, a chart).
Answer with one of: sheet, document, site, calculator, none.
Answer:

### Checks

- starts: site

### Options

max_tokens: 12
system: You sort a request that a person sent to an assistant. Reply with one word from the list. Judge by what the request asks for, not by the language it is written in.


## file-10 calculator

Request: """convertisseur euros dollars"""
Question: What file does the request ask to be made? sheet = an Excel spreadsheet or a table of figures; document = a written document (a letter, a report, a CV, minutes, a contract, a research document); site = a website or a landing page; calculator = a small calculator, converter or simulator page; none = anything else (a program, a game, a chat, a question, a chart).
Answer with one of: sheet, document, site, calculator, none.
Answer:

### Checks

- starts: calculator

### Options

max_tokens: 12
system: You sort a request that a person sent to an assistant. Reply with one word from the list. Judge by what the request asks for, not by the language it is written in.


## file-11 calculator

Request: """BMI calculator"""
Question: What file does the request ask to be made? sheet = an Excel spreadsheet or a table of figures; document = a written document (a letter, a report, a CV, minutes, a contract, a research document); site = a website or a landing page; calculator = a small calculator, converter or simulator page; none = anything else (a program, a game, a chat, a question, a chart).
Answer with one of: sheet, document, site, calculator, none.
Answer:

### Checks

- starts: calculator

### Options

max_tokens: 12
system: You sort a request that a person sent to an assistant. Reply with one word from the list. Judge by what the request asks for, not by the language it is written in.


## file-13 none

Request: """make tetris"""
Question: What file does the request ask to be made? sheet = an Excel spreadsheet or a table of figures; document = a written document (a letter, a report, a CV, minutes, a contract, a research document); site = a website or a landing page; calculator = a small calculator, converter or simulator page; none = anything else (a program, a game, a chat, a question, a chart).
Answer with one of: sheet, document, site, calculator, none.
Answer:

### Checks

- starts: none

### Options

max_tokens: 12
system: You sort a request that a person sent to an assistant. Reply with one word from the list. Judge by what the request asks for, not by the language it is written in.


## file-16 none

Request: """bonjour"""
Question: What file does the request ask to be made? sheet = an Excel spreadsheet or a table of figures; document = a written document (a letter, a report, a CV, minutes, a contract, a research document); site = a website or a landing page; calculator = a small calculator, converter or simulator page; none = anything else (a program, a game, a chat, a question, a chart).
Answer with one of: sheet, document, site, calculator, none.
Answer:

### Checks

- starts: none

### Options

max_tokens: 12
system: You sort a request that a person sent to an assistant. Reply with one word from the list. Judge by what the request asks for, not by the language it is written in.


## file-17 none

Request: """what is a spreadsheet?"""
Question: What file does the request ask to be made? sheet = an Excel spreadsheet or a table of figures; document = a written document (a letter, a report, a CV, minutes, a contract, a research document); site = a website or a landing page; calculator = a small calculator, converter or simulator page; none = anything else (a program, a game, a chat, a question, a chart).
Answer with one of: sheet, document, site, calculator, none.
Answer:

### Checks

- starts: none

### Options

max_tokens: 12
system: You sort a request that a person sent to an assistant. Reply with one word from the list. Judge by what the request asks for, not by the language it is written in.


## file-18 none

Request: """explain how websites work"""
Question: What file does the request ask to be made? sheet = an Excel spreadsheet or a table of figures; document = a written document (a letter, a report, a CV, minutes, a contract, a research document); site = a website or a landing page; calculator = a small calculator, converter or simulator page; none = anything else (a program, a game, a chat, a question, a chart).
Answer with one of: sheet, document, site, calculator, none.
Answer:

### Checks

- starts: none

### Options

max_tokens: 12
system: You sort a request that a person sent to an assistant. Reply with one word from the list. Judge by what the request asks for, not by the language it is written in.


## file-19 none

Request: """make me a chart of GDP by country"""
Question: What file does the request ask to be made? sheet = an Excel spreadsheet or a table of figures; document = a written document (a letter, a report, a CV, minutes, a contract, a research document); site = a website or a landing page; calculator = a small calculator, converter or simulator page; none = anything else (a program, a game, a chat, a question, a chart).
Answer with one of: sheet, document, site, calculator, none.
Answer:

### Checks

- starts: none

### Options

max_tokens: 12
system: You sort a request that a person sent to an assistant. Reply with one word from the list. Judge by what the request asks for, not by the language it is written in.


## file-20 none

Request: """merci !"""
Question: What file does the request ask to be made? sheet = an Excel spreadsheet or a table of figures; document = a written document (a letter, a report, a CV, minutes, a contract, a research document); site = a website or a landing page; calculator = a small calculator, converter or simulator page; none = anything else (a program, a game, a chat, a question, a chart).
Answer with one of: sheet, document, site, calculator, none.
Answer:

### Checks

- starts: none

### Options

max_tokens: 12
system: You sort a request that a person sent to an assistant. Reply with one word from the list. Judge by what the request asks for, not by the language it is written in.


## file-22 none

Request: """write a poem about the sea"""
Question: What file does the request ask to be made? sheet = an Excel spreadsheet or a table of figures; document = a written document (a letter, a report, a CV, minutes, a contract, a research document); site = a website or a landing page; calculator = a small calculator, converter or simulator page; none = anything else (a program, a game, a chat, a question, a chart).
Answer with one of: sheet, document, site, calculator, none.
Answer:

### Checks

- starts: none

### Options

max_tokens: 12
system: You sort a request that a person sent to an assistant. Reply with one word from the list. Judge by what the request asks for, not by the language it is written in.

## produce-02 hands a document over

Request: """tiens un document"""
Question: Does the person ask you to PRODUCE a file or a document now (make it, write it, create it), rather than ask for help, advice, an explanation, a summary, a review, or just talk?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: create a rental contract for me as a Word document -> yes; make an Excel file with my monthly expenses -> yes; do some research on solar panels and write a report -> yes; make me a family budget in a spreadsheet -> yes; can you check my CV and tell me what to improve? -> no; I have a probability exercise, can you help me understand it? -> no; here, this is my file -> no; can you summarize this text for me? -> no.
max_tokens: 12

## produce-04 letter to produce

Request: """write me a cover letter for a barista job"""
Question: Does the person ask you to PRODUCE a file or a document now (make it, write it, create it), rather than ask for help, advice, an explanation, a summary, a review, or just talk?
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: create a rental contract for me as a Word document -> yes; make an Excel file with my monthly expenses -> yes; do some research on solar panels and write a report -> yes; make me a family budget in a spreadsheet -> yes; can you check my CV and tell me what to improve? -> no; I have a probability exercise, can you help me understand it? -> no; here, this is my file -> no; can you summarize this text for me? -> no.
max_tokens: 12

## produce-06 review

Request: """review my essay and tell me what is weak"""
Question: Does the person ask you to PRODUCE a file or a document now (make it, write it, create it), rather than ask for help, advice, an explanation, a summary, a review, or just talk?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: create a rental contract for me as a Word document -> yes; make an Excel file with my monthly expenses -> yes; do some research on solar panels and write a report -> yes; make me a family budget in a spreadsheet -> yes; can you check my CV and tell me what to improve? -> no; I have a probability exercise, can you help me understand it? -> no; here, this is my file -> no; can you summarize this text for me? -> no.
max_tokens: 12

## produce-09 research doc

Request: """do some research on american healthcare and make a research doc"""
Question: Does the person ask you to PRODUCE a file or a document now (make it, write it, create it), rather than ask for help, advice, an explanation, a summary, a review, or just talk?
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: create a rental contract for me as a Word document -> yes; make an Excel file with my monthly expenses -> yes; do some research on solar panels and write a report -> yes; make me a family budget in a spreadsheet -> yes; can you check my CV and tell me what to improve? -> no; I have a probability exercise, can you help me understand it? -> no; here, this is my file -> no; can you summarize this text for me? -> no.
max_tokens: 12

## produce-11 help

Request: """can you help me with my budget?"""
Question: Does the person ask you to PRODUCE a file or a document now (make it, write it, create it), rather than ask for help, advice, an explanation, a summary, a review, or just talk?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: create a rental contract for me as a Word document -> yes; make an Excel file with my monthly expenses -> yes; do some research on solar panels and write a report -> yes; make me a family budget in a spreadsheet -> yes; can you check my CV and tell me what to improve? -> no; I have a probability exercise, can you help me understand it? -> no; here, this is my file -> no; can you summarize this text for me? -> no.
max_tokens: 12

## produce-12 spreadsheet to produce

Request: """make me a budget spreadsheet for my family"""
Question: Does the person ask you to PRODUCE a file or a document now (make it, write it, create it), rather than ask for help, advice, an explanation, a summary, a review, or just talk?
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: create a rental contract for me as a Word document -> yes; make an Excel file with my monthly expenses -> yes; do some research on solar panels and write a report -> yes; make me a family budget in a spreadsheet -> yes; can you check my CV and tell me what to improve? -> no; I have a probability exercise, can you help me understand it? -> no; here, this is my file -> no; can you summarize this text for me? -> no.
max_tokens: 12

## produce-13 opinion

Request: """what do you think of this contract?"""
Question: Does the person ask you to PRODUCE a file or a document now (make it, write it, create it), rather than ask for help, advice, an explanation, a summary, a review, or just talk?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: create a rental contract for me as a Word document -> yes; make an Excel file with my monthly expenses -> yes; do some research on solar panels and write a report -> yes; make me a family budget in a spreadsheet -> yes; can you check my CV and tell me what to improve? -> no; I have a probability exercise, can you help me understand it? -> no; here, this is my file -> no; can you summarize this text for me? -> no.
max_tokens: 12

## produceb-02 hands a document over

Request: """tiens un document"""
Question: Does the message tell you to make, write or create a new file or document for the person (a letter, a sheet, a report, a CV)?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: create a rental contract for me as a Word document -> yes; make an Excel file with my monthly expenses -> yes; do some research on solar panels and write a report -> yes; make me a family budget in a spreadsheet -> yes; can you check my CV and tell me what to improve? -> no; I have a probability exercise, can you help me understand it? -> no; here, this is my file -> no; can you summarize this text for me? -> no.
max_tokens: 12

## produceb-04 letter to produce

Request: """write me a cover letter for a barista job"""
Question: Does the message tell you to make, write or create a new file or document for the person (a letter, a sheet, a report, a CV)?
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: create a rental contract for me as a Word document -> yes; make an Excel file with my monthly expenses -> yes; do some research on solar panels and write a report -> yes; make me a family budget in a spreadsheet -> yes; can you check my CV and tell me what to improve? -> no; I have a probability exercise, can you help me understand it? -> no; here, this is my file -> no; can you summarize this text for me? -> no.
max_tokens: 12

## produceb-06 review

Request: """review my essay and tell me what is weak"""
Question: Does the message tell you to make, write or create a new file or document for the person (a letter, a sheet, a report, a CV)?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: create a rental contract for me as a Word document -> yes; make an Excel file with my monthly expenses -> yes; do some research on solar panels and write a report -> yes; make me a family budget in a spreadsheet -> yes; can you check my CV and tell me what to improve? -> no; I have a probability exercise, can you help me understand it? -> no; here, this is my file -> no; can you summarize this text for me? -> no.
max_tokens: 12

## produceb-09 research doc

Request: """do some research on american healthcare and make a research doc"""
Question: Does the message tell you to make, write or create a new file or document for the person (a letter, a sheet, a report, a CV)?
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: create a rental contract for me as a Word document -> yes; make an Excel file with my monthly expenses -> yes; do some research on solar panels and write a report -> yes; make me a family budget in a spreadsheet -> yes; can you check my CV and tell me what to improve? -> no; I have a probability exercise, can you help me understand it? -> no; here, this is my file -> no; can you summarize this text for me? -> no.
max_tokens: 12

## produceb-11 help

Request: """can you help me with my budget?"""
Question: Does the message tell you to make, write or create a new file or document for the person (a letter, a sheet, a report, a CV)?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: create a rental contract for me as a Word document -> yes; make an Excel file with my monthly expenses -> yes; do some research on solar panels and write a report -> yes; make me a family budget in a spreadsheet -> yes; can you check my CV and tell me what to improve? -> no; I have a probability exercise, can you help me understand it? -> no; here, this is my file -> no; can you summarize this text for me? -> no.
max_tokens: 12

## produceb-12 spreadsheet to produce

Request: """make me a budget spreadsheet for my family"""
Question: Does the message tell you to make, write or create a new file or document for the person (a letter, a sheet, a report, a CV)?
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: create a rental contract for me as a Word document -> yes; make an Excel file with my monthly expenses -> yes; do some research on solar panels and write a report -> yes; make me a family budget in a spreadsheet -> yes; can you check my CV and tell me what to improve? -> no; I have a probability exercise, can you help me understand it? -> no; here, this is my file -> no; can you summarize this text for me? -> no.
max_tokens: 12

## produceb-13 opinion

Request: """what do you think of this contract?"""
Question: Does the message tell you to make, write or create a new file or document for the person (a letter, a sheet, a report, a CV)?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: create a rental contract for me as a Word document -> yes; make an Excel file with my monthly expenses -> yes; do some research on solar panels and write a report -> yes; make me a family budget in a spreadsheet -> yes; can you check my CV and tell me what to improve? -> no; I have a probability exercise, can you help me understand it? -> no; here, this is my file -> no; can you summarize this text for me? -> no.
max_tokens: 12

## producec-02 hands a document over

Request: """tiens un document"""
Question: Is the thing wanted a NEW file or document as the result, rather than an answer in the chat?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: create a rental contract for me as a Word document -> yes; make an Excel file with my monthly expenses -> yes; do some research on solar panels and write a report -> yes; make me a family budget in a spreadsheet -> yes; can you check my CV and tell me what to improve? -> no; I have a probability exercise, can you help me understand it? -> no; here, this is my file -> no; can you summarize this text for me? -> no.
max_tokens: 12

## producec-04 letter to produce

Request: """write me a cover letter for a barista job"""
Question: Is the thing wanted a NEW file or document as the result, rather than an answer in the chat?
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: create a rental contract for me as a Word document -> yes; make an Excel file with my monthly expenses -> yes; do some research on solar panels and write a report -> yes; make me a family budget in a spreadsheet -> yes; can you check my CV and tell me what to improve? -> no; I have a probability exercise, can you help me understand it? -> no; here, this is my file -> no; can you summarize this text for me? -> no.
max_tokens: 12

## producec-06 review

Request: """review my essay and tell me what is weak"""
Question: Is the thing wanted a NEW file or document as the result, rather than an answer in the chat?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: create a rental contract for me as a Word document -> yes; make an Excel file with my monthly expenses -> yes; do some research on solar panels and write a report -> yes; make me a family budget in a spreadsheet -> yes; can you check my CV and tell me what to improve? -> no; I have a probability exercise, can you help me understand it? -> no; here, this is my file -> no; can you summarize this text for me? -> no.
max_tokens: 12

## producec-09 research doc

Request: """do some research on american healthcare and make a research doc"""
Question: Is the thing wanted a NEW file or document as the result, rather than an answer in the chat?
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: create a rental contract for me as a Word document -> yes; make an Excel file with my monthly expenses -> yes; do some research on solar panels and write a report -> yes; make me a family budget in a spreadsheet -> yes; can you check my CV and tell me what to improve? -> no; I have a probability exercise, can you help me understand it? -> no; here, this is my file -> no; can you summarize this text for me? -> no.
max_tokens: 12

## producec-11 help

Request: """can you help me with my budget?"""
Question: Is the thing wanted a NEW file or document as the result, rather than an answer in the chat?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: create a rental contract for me as a Word document -> yes; make an Excel file with my monthly expenses -> yes; do some research on solar panels and write a report -> yes; make me a family budget in a spreadsheet -> yes; can you check my CV and tell me what to improve? -> no; I have a probability exercise, can you help me understand it? -> no; here, this is my file -> no; can you summarize this text for me? -> no.
max_tokens: 12

## producec-12 spreadsheet to produce

Request: """make me a budget spreadsheet for my family"""
Question: Is the thing wanted a NEW file or document as the result, rather than an answer in the chat?
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: create a rental contract for me as a Word document -> yes; make an Excel file with my monthly expenses -> yes; do some research on solar panels and write a report -> yes; make me a family budget in a spreadsheet -> yes; can you check my CV and tell me what to improve? -> no; I have a probability exercise, can you help me understand it? -> no; here, this is my file -> no; can you summarize this text for me? -> no.
max_tokens: 12

## producec-13 opinion

Request: """what do you think of this contract?"""
Question: Is the thing wanted a NEW file or document as the result, rather than an answer in the chat?
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: create a rental contract for me as a Word document -> yes; make an Excel file with my monthly expenses -> yes; do some research on solar panels and write a report -> yes; make me a family budget in a spreadsheet -> yes; can you check my CV and tell me what to improve? -> no; I have a probability exercise, can you help me understand it? -> no; here, this is my file -> no; can you summarize this text for me? -> no.
max_tokens: 12

## agents-01 greeting

Request: """hi friend"""
Question: Does this request ask for sub-agents, or is it a big job that splits into independent parts that can each be worked out alone (researching several things, drafting several sections, comparing several options)? (Answer no for a greeting, a chat, a small question or a single simple task.)
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in.
max_tokens: 12


## agents-02 small question

Request: """what does CUMP mean in accounting?"""
Question: Does this request ask for sub-agents, or is it a big job that splits into independent parts that can each be worked out alone (researching several things, drafting several sections, comparing several options)? (Answer no for a greeting, a chat, a small question or a single simple task.)
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in.
max_tokens: 12


## agents-03 multi-part job

Request: """I need research for my thesis: find me three recent studies on sleep and memory, summarize each one, and make a table comparing their sample sizes and results"""
Question: Does this request ask for sub-agents, or is it a big job that splits into independent parts that can each be worked out alone (researching several things, drafting several sections, comparing several options)? (Answer no for a greeting, a chat, a small question or a single simple task.)
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in.
max_tokens: 12


## recall-01 earlier file

Request: """what was the name of the file you made for the household budget earlier?"""
Question: Does the message ask about something that was said, decided, written or agreed EARLIER in the conversation, which the summary of it at the start may not hold in full (an earlier answer, an earlier file, a value or a name from before)? (Answer no when the message is only about what is on the screen now, or asks for something new.)
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in.
max_tokens: 12


## recall-02 agreed value

Request: """remind me what discount percentage we settled on before"""
Question: Does the message ask about something that was said, decided, written or agreed EARLIER in the conversation, which the summary of it at the start may not hold in full (an earlier answer, an earlier file, a value or a name from before)? (Answer no when the message is only about what is on the screen now, or asks for something new.)
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in.
max_tokens: 12


## recall-03 on the screen now

Request: """make the title bigger and the text darker"""
Question: Does the message ask about something that was said, decided, written or agreed EARLIER in the conversation, which the summary of it at the start may not hold in full (an earlier answer, an earlier file, a value or a name from before)? (Answer no when the message is only about what is on the screen now, or asks for something new.)
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in.
max_tokens: 12


## recall-04 asks for something new

Request: """write a letter to the bank asking to unblock my card"""
Question: Does the message ask about something that was said, decided, written or agreed EARLIER in the conversation, which the summary of it at the start may not hold in full (an earlier answer, an earlier file, a value or a name from before)? (Answer no when the message is only about what is on the screen now, or asks for something new.)
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in.
max_tokens: 12


## recall-05 Arabic, an earlier decision

Request: """ما هو الاسم الذي اتفقنا عليه سابقا للمشروع؟"""
Question: Does the message ask about something that was said, decided, written or agreed EARLIER in the conversation, which the summary of it at the start may not hold in full (an earlier answer, an earlier file, a value or a name from before)? (Answer no when the message is only about what is on the screen now, or asks for something new.)
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in.
max_tokens: 12

## identity-01 who

Request: """Who are you?"""
Question: Is the message asking who you are, what your name is, or who made or built you? (Answer no when it asks you to make, write or change anything, or asks about a person, a thing or any other subject.)
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: what should I call you? -> yes; tell me about yourself — who created this app of yours? -> yes; هل أنت ذكاء اصطناعي؟ من صمّمك؟ -> yes; بصراحة، مَن اسمك؟ -> yes; make me a chatbot page for my shop -> no; write a poem about a robot who lost its name -> no; من هو مخترع الهاتف؟ -> no; make me a site for my robotics club -> no.
max_tokens: 12


## identity-02 model

Request: """what model are you running on?"""
Question: Is the message asking who you are, what your name is, or who made or built you? (Answer no when it asks you to make, write or change anything, or asks about a person, a thing or any other subject.)
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: what should I call you? -> yes; tell me about yourself — who created this app of yours? -> yes; هل أنت ذكاء اصطناعي؟ من صمّمك؟ -> yes; بصراحة، مَن اسمك؟ -> yes; make me a chatbot page for my shop -> no; write a poem about a robot who lost its name -> no; من هو مخترع الهاتف؟ -> no; make me a site for my robotics club -> no.
max_tokens: 12


## identity-03 name again

Request: """hi, what is your name again?"""
Question: Is the message asking who you are, what your name is, or who made or built you? (Answer no when it asks you to make, write or change anything, or asks about a person, a thing or any other subject.)
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: what should I call you? -> yes; tell me about yourself — who created this app of yours? -> yes; هل أنت ذكاء اصطناعي؟ من صمّمك؟ -> yes; بصراحة، مَن اسمك؟ -> yes; make me a chatbot page for my shop -> no; write a poem about a robot who lost its name -> no; من هو مخترع الهاتف؟ -> no; make me a site for my robotics club -> no.
max_tokens: 12


## identity-04 maker

Request: """من طورك؟"""
Question: Is the message asking who you are, what your name is, or who made or built you? (Answer no when it asks you to make, write or change anything, or asks about a person, a thing or any other subject.)
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: what should I call you? -> yes; tell me about yourself — who created this app of yours? -> yes; هل أنت ذكاء اصطناعي؟ من صمّمك؟ -> yes; بصراحة، مَن اسمك؟ -> yes; make me a chatbot page for my shop -> no; write a poem about a robot who lost its name -> no; من هو مخترع الهاتف؟ -> no; make me a site for my robotics club -> no.
max_tokens: 12


## identity-05 what are you

Request: """هل يمكنك أن تخبرني من أنت؟"""
Question: Is the message asking who you are, what your name is, or who made or built you? (Answer no when it asks you to make, write or change anything, or asks about a person, a thing or any other subject.)
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: what should I call you? -> yes; tell me about yourself — who created this app of yours? -> yes; هل أنت ذكاء اصطناعي؟ من صمّمك؟ -> yes; بصراحة، مَن اسمك؟ -> yes; make me a chatbot page for my shop -> no; write a poem about a robot who lost its name -> no; من هو مخترع الهاتف؟ -> no; make me a site for my robotics club -> no.
max_tokens: 12


## identity-06 chatbot build

Request: """make me a chatbot for my website"""
Question: Is the message asking who you are, what your name is, or who made or built you? (Answer no when it asks you to make, write or change anything, or asks about a person, a thing or any other subject.)
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: what should I call you? -> yes; tell me about yourself — who created this app of yours? -> yes; هل أنت ذكاء اصطناعي؟ من صمّمك؟ -> yes; بصراحة، مَن اسمك؟ -> yes; make me a chatbot page for my shop -> no; write a poem about a robot who lost its name -> no; من هو مخترع الهاتف؟ -> no; make me a site for my robotics club -> no.
max_tokens: 12


## identity-07 robot poem

Request: """write a poem about a robot who forgot its name"""
Question: Is the message asking who you are, what your name is, or who made or built you? (Answer no when it asks you to make, write or change anything, or asks about a person, a thing or any other subject.)
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: what should I call you? -> yes; tell me about yourself — who created this app of yours? -> yes; هل أنت ذكاء اصطناعي؟ من صمّمك؟ -> yes; بصراحة، مَن اسمك؟ -> yes; make me a chatbot page for my shop -> no; write a poem about a robot who lost its name -> no; من هو مخترع الهاتف؟ -> no; make me a site for my robotics club -> no.
max_tokens: 12


## identity-08 invention

Request: """who invented the telephone?"""
Question: Is the message asking who you are, what your name is, or who made or built you? (Answer no when it asks you to make, write or change anything, or asks about a person, a thing or any other subject.)
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: what should I call you? -> yes; tell me about yourself — who created this app of yours? -> yes; هل أنت ذكاء اصطناعي؟ من صمّمك؟ -> yes; بصراحة، مَن اسمك؟ -> yes; make me a chatbot page for my shop -> no; write a poem about a robot who lost its name -> no; من هو مخترع الهاتف؟ -> no; make me a site for my robotics club -> no.
max_tokens: 12


## identity-09 invention ar

Request: """من اخترع الهاتف؟"""
Question: Is the message asking who you are, what your name is, or who made or built you? (Answer no when it asks you to make, write or change anything, or asks about a person, a thing or any other subject.)
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: what should I call you? -> yes; tell me about yourself — who created this app of yours? -> yes; هل أنت ذكاء اصطناعي؟ من صمّمك؟ -> yes; بصراحة، مَن اسمك؟ -> yes; make me a chatbot page for my shop -> no; write a poem about a robot who lost its name -> no; من هو مخترع الهاتف؟ -> no; make me a site for my robotics club -> no.
max_tokens: 12


## identity-10 favorite language

Request: """what is your favorite programming language?"""
Question: Is the message asking who you are, what your name is, or who made or built you? (Answer no when it asks you to make, write or change anything, or asks about a person, a thing or any other subject.)
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: what should I call you? -> yes; tell me about yourself — who created this app of yours? -> yes; هل أنت ذكاء اصطناعي؟ من صمّمك؟ -> yes; بصراحة، مَن اسمك؟ -> yes; make me a chatbot page for my shop -> no; write a poem about a robot who lost its name -> no; من هو مخترع الهاتف؟ -> no; make me a site for my robotics club -> no.
max_tokens: 12

## program-24 short game

Request: """a snake game in html"""
Question: Does it ask to build, write or change something that RUNS: a program, game, app, tool or web page, or say that something in one does not work or looks wrong? (Answer no for a chat, a question, an explanation, a chart, a spreadsheet, an Excel or Word file, a text document or a thanks.)
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: make me a tic-tac-toe game -> yes; I would like a stopwatch app with lap times -> yes; the score does not update after a level, fix it -> yes; add a dark mode switch to the page -> yes; make me a chess game I can play against the computer -> yes; أريد لعبة إكس-أو ألعبها ضد الكمبيوتر -> yes; explain the difference between a list and a tuple in python -> no; write an email to move my appointment -> no; make me an excel table of my groceries -> no; what is the capital of Canada? -> no; what was the score of yesterday's game? -> no.
max_tokens: 12


## program-25 Arabic game

Request: """اعمل لي لعبة ذاكرة بالبطاقات"""
Question: Does it ask to build, write or change something that RUNS: a program, game, app, tool or web page, or say that something in one does not work or looks wrong? (Answer no for a chat, a question, an explanation, a chart, a spreadsheet, an Excel or Word file, a text document or a thanks.)
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: make me a tic-tac-toe game -> yes; I would like a stopwatch app with lap times -> yes; the score does not update after a level, fix it -> yes; add a dark mode switch to the page -> yes; make me a chess game I can play against the computer -> yes; أريد لعبة إكس-أو ألعبها ضد الكمبيوتر -> yes; explain the difference between a list and a tuple in python -> no; write an email to move my appointment -> no; make me an excel table of my groceries -> no; what is the capital of Canada? -> no; what was the score of yesterday's game? -> no.
max_tokens: 12


## confirm-01 the recorded recall miss (spare key)

Request: """Where is the spare key to the reading room kept again?"""
Question: Does the message ask you to make a program, page or file? (Answer no when it only asks a question or wants an answer in the chat.)
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: build me a pomodoro timer page -> yes; make a small program that renames my photos by the date taken -> yes; زر الحفظ في الأداة لا يعمل، أصلحه -> yes; what time does the museum open? -> no; ما عاصمة اليابان؟ -> no; summarize the meeting notes for me -> no.
max_tokens: 12

## confirm-02 the recorded recall miss (catalog login)

Request: """What is the login for the catalog station again?"""
Question: Does the message ask you to make a program, page or file? (Answer no when it only asks a question or wants an answer in the chat.)
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: build me a pomodoro timer page -> yes; make a small program that renames my photos by the date taken -> yes; زر الحفظ في الأداة لا يعمل، أصلحه -> yes; what time does the museum open? -> no; ما عاصمة اليابان؟ -> no; summarize the meeting notes for me -> no.
max_tokens: 12

## confirm-03 the recorded recall miss, Arabic (key cabinet)

Request: """أين خزانة المفاتيح الاحتياطية مرة أخرى؟"""
Question: Does the message ask you to make a program, page or file? (Answer no when it only asks a question or wants an answer in the chat.)
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: build me a pomodoro timer page -> yes; make a small program that renames my photos by the date taken -> yes; زر الحفظ في الأداة لا يعمل، أصلحه -> yes; what time does the museum open? -> no; ما عاصمة اليابان؟ -> no; summarize the meeting notes for me -> no.
max_tokens: 12

## confirm-04 the recorded recall miss, Arabic (catalog login)

Request: """ما اسم الدخول لجهاز الفهرس؟"""
Question: Does the message ask you to make a program, page or file? (Answer no when it only asks a question or wants an answer in the chat.)
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: build me a pomodoro timer page -> yes; make a small program that renames my photos by the date taken -> yes; زر الحفظ في الأداة لا يعمل، أصلحه -> yes; what time does the museum open? -> no; ما عاصمة اليابان؟ -> no; summarize the meeting notes for me -> no.
max_tokens: 12

## confirm-05 the recorded knowledge miss (overdue fine)

Request: """What is the overdue fine per day?"""
Question: Does the message ask you to make a program, page or file? (Answer no when it only asks a question or wants an answer in the chat.)
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: build me a pomodoro timer page -> yes; make a small program that renames my photos by the date taken -> yes; زر الحفظ في الأداة لا يعمل، أصلحه -> yes; what time does the museum open? -> no; ما عاصمة اليابان؟ -> no; summarize the meeting notes for me -> no.
max_tokens: 12

## confirm-06 the recorded knowledge miss (book sale)

Request: """When is the annual book sale held?"""
Question: Does the message ask you to make a program, page or file? (Answer no when it only asks a question or wants an answer in the chat.)
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: build me a pomodoro timer page -> yes; make a small program that renames my photos by the date taken -> yes; زر الحفظ في الأداة لا يعمل، أصلحه -> yes; what time does the museum open? -> no; ما عاصمة اليابان؟ -> no; summarize the meeting notes for me -> no.
max_tokens: 12

## confirm-07 the recorded knowledge miss, Arabic (fine per day)

Request: """كم غرامة التأخير عن كل يوم؟"""
Question: Does the message ask you to make a program, page or file? (Answer no when it only asks a question or wants an answer in the chat.)
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: build me a pomodoro timer page -> yes; make a small program that renames my photos by the date taken -> yes; زر الحفظ في الأداة لا يعمل، أصلحه -> yes; what time does the museum open? -> no; ما عاصمة اليابان؟ -> no; summarize the meeting notes for me -> no.
max_tokens: 12

## confirm-08 the recorded knowledge miss, Arabic (eastern branch opening)

Request: """متى افتتح الفرع الشرقي؟"""
Question: Does the message ask you to make a program, page or file? (Answer no when it only asks a question or wants an answer in the chat.)
Answer (yes or no):

### Checks

- starts: no

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: build me a pomodoro timer page -> yes; make a small program that renames my photos by the date taken -> yes; زر الحفظ في الأداة لا يعمل، أصلحه -> yes; what time does the museum open? -> no; ما عاصمة اليابان؟ -> no; summarize the meeting notes for me -> no.
max_tokens: 12

## confirm-09 a build request still confirmed yes (tetris)

Request: """make tetris"""
Question: Does the message ask you to make a program, page or file? (Answer no when it only asks a question or wants an answer in the chat.)
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: build me a pomodoro timer page -> yes; make a small program that renames my photos by the date taken -> yes; زر الحفظ في الأداة لا يعمل، أصلحه -> yes; what time does the museum open? -> no; ما عاصمة اليابان؟ -> no; summarize the meeting notes for me -> no.
max_tokens: 12

## confirm-10 a build request still confirmed yes, Arabic (make a game)

Request: """اصنع لعبة"""
Question: Does the message ask you to make a program, page or file? (Answer no when it only asks a question or wants an answer in the chat.)
Answer (yes or no):

### Checks

- starts: yes

### Options

system: You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in. Solved cases for this question: build me a pomodoro timer page -> yes; make a small program that renames my photos by the date taken -> yes; زر الحفظ في الأداة لا يعمل، أصلحه -> yes; what time does the museum open? -> no; ما عاصمة اليابان؟ -> no; summarize the meeting notes for me -> no.
max_tokens: 12
