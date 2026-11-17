import { describe, expect, it } from "vitest";
import { forVoice, guessLang, latinize, learnAcronyms, speakAcronyms, speakNumbers } from "../src/core/speakNumbers";

describe("what the voice is given", () => {
  it("writes years and numbers out in English", () => {
    expect(speakNumbers("In 1986 Vietnam changed.", "en")).toBe("In nineteen eighty-six Vietnam changed.");
    expect(speakNumbers("In 2007 it joined.", "en")).toBe("In two thousand seven it joined.");
    expect(speakNumbers("In 1900 and 2015.", "en")).toBe("In nineteen hundred and twenty fifteen.");
    expect(speakNumbers("It had 475 members and 12,500 more.", "en")).toBe("It had four hundred seventy-five members and twelve thousand five hundred more.");
    expect(speakNumbers("About 48 billion dollars, or $475 million.", "en")).toBe("About forty-eight billion dollars, or four hundred seventy-five million dollars.");
    expect(speakNumbers("Growth was 3.5% in the 21st year.", "en")).toBe("Growth was three point five percent in the twenty-first year.");
  });
  it("reduces letters with diacritics to plain letters", () => {
    expect(latinize("\u0110\u1ed5i M\u1edbi, Nguy\u1ec5n")).toBe("Doi Moi, Nguyen");
    expect(latinize("caf\u00e9")).toBe("cafe");
  });
  it("speaks English", () => {
    expect(guessLang("The reforms of 1986 opened the economy.")).toBe("en");
    expect(forVoice("\u0110\u1ed5i M\u1edbi started in 1986.")).toBe("Doi Moi started in nineteen eighty-six.");
  });
  it("spells acronyms, says the ones that are words, and leaves capitals that are not acronyms", () => {
    expect(speakAcronyms("The IMF, WTO and ILO joined the ASEAN.")).toBe("The International Monetary Fund, World Trade Organization and International Labour Organization joined the Ah-see-ahn.");
    expect(speakAcronyms("The XYZ and ABC agreed.")).toBe("The X Y Z and A B C agreed.");
    expect(speakAcronyms("Four NPUs and 16 GB of RAM, OK?")).toBe("Four neural processing units and 16 gigabytes of ram, okay?");
    expect(speakAcronyms("Louis XIV and World War II.")).toBe("Louis XIV and World War II.");
    expect(speakAcronyms("THIS IS A WARNING TO ALL")).toBe("THIS IS A WARNING TO ALL");
    expect(speakAcronyms("GPT-4 and iPhone, NVMe")).toBe("G P T-4 and iPhone, NVMe");
    expect(forVoice("The IMF lent 48 billion dollars in 1986.")).toBe("The International Monetary Fund lent forty-eight billion dollars in nineteen eighty-six.");
  });
  it("learns the acronyms a text defines, says the name once where it is defined and the name later", () => {
    const text = "The Association of Southeast Asian Nations (ASEAN) began in 1967. Later the FTA (Free Trade Agreement) helped. The XYZ Board (XYZ) met.";
    const known = learnAcronyms(text);
    expect(known.ASEAN).toBe("Association of Southeast Asian Nations");
    expect(known.FTA).toBe("Free Trade Agreement");
    expect(speakAcronyms("The Association of Southeast Asian Nations (ASEAN) began.", known)).toBe("The Association of Southeast Asian Nations began.");
    expect(speakAcronyms("The FTA (Free Trade Agreement) helped, and the FTA grew.", known)).toBe("The Free Trade Agreement helped, and the Free Trade Agreement grew.");
    expect(speakAcronyms("Did ASEAN grow?", known)).toBe("Did Association of Southeast Asian Nations grow?");
  });
});
