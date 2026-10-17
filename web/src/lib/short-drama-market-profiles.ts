import { DramaEra as E, DramaGenre as G, DramaLanguage as L, DramaRegion as R, DramaTargetMarket as M, DramaTone as T, DramaVisualStyle as S } from "./short-drama-settings-catalog";

export const dramaMarketResearchDate = "2026-10-16";
export type DramaMarketProfile = {
    language: L;
    region: R;
    genre: readonly [G, ...G[]];
    tone: readonly [T, ...T[]];
    visualStyle: readonly [S, ...S[]];
    era: readonly [E, ...E[]];
};

// Editorial starting points, not a popularity ranking or regional restrictions.
// Evidence, dates and gaps are documented in docs/plans/drama-market-settings.md.
// The first option is the default applied ONLY on an explicit market change.
export const dramaMarketProfiles: Record<M, DramaMarketProfile> = {
    [M.China]: {
        language: L.SimplifiedChinese, region: R.China,
        genre: [G.Family, G.FemaleGrowth, G.PeriodLife, G.SweetRomance, G.Suspense, G.Comedy, G.Rebirth, G.Underdog, G.TimeTravel, G.Historical, G.RuralLife, G.Xianxia, G.Wuxia],
        tone: [T.Warm, T.Moving, T.Light, T.Cathartic, T.Tense, T.Sweet, T.Nostalgic],
        visualStyle: [S.Cinematic, S.Natural, S.Soft, S.Documentary, S.Retro, S.Ink, S.Period],
        era: [E.Contemporary, E.Eighties, E.Nineties, E.Seventies, E.Y2K, E.Ancient, E.Early20th, E.Fictional],
    },
    [M.NorthAmerica]: {
        language: L.English, region: R.NorthAmerica,
        genre: [G.Romance, G.ContractRomance, G.Revenge, G.Werewolf, G.Vampire, G.RoyalRomance, G.SecondChance, G.Youth, G.Thriller, G.Fantasy, G.Family],
        tone: [T.Romantic, T.Bittersweet, T.Cathartic, T.Tense, T.Dark, T.Sweet],
        visualStyle: [S.Glossy, S.Cinematic, S.Natural, S.Gothic, S.Noir, S.Retro],
        era: [E.Contemporary, E.Y2K, E.Nineties, E.Nineteenth, E.Medieval, E.NearFuture, E.Fictional],
    },
    [M.Japan]: {
        language: L.Japanese, region: R.Japan,
        genre: [G.Underdog, G.Family, G.FemaleGrowth, G.Revenge, G.Workplace, G.Romance, G.Youth, G.Suspense, G.Comedy, G.Fantasy],
        tone: [T.Cathartic, T.Moving, T.Warm, T.Tense, T.Restrained, T.Sweet, T.Nostalgic],
        visualStyle: [S.Natural, S.Soft, S.Cinematic, S.Anime, S.Watercolor, S.Retro],
        era: [E.Contemporary, E.Y2K, E.Nineties, E.Eighties, E.MidCentury, E.Ancient, E.NearFuture],
    },
    [M.Korea]: {
        language: L.Korean, region: R.Korea,
        genre: [G.SweetRomance, G.ContractRomance, G.Revenge, G.Rebirth, G.FemaleGrowth, G.Workplace, G.Youth, G.Suspense, G.Family, G.Fantasy, G.Historical],
        tone: [T.Sweet, T.Bittersweet, T.Cathartic, T.Tense, T.Warm, T.Moving],
        visualStyle: [S.Soft, S.Glossy, S.Cinematic, S.Natural, S.Webtoon, S.Noir],
        era: [E.Contemporary, E.Y2K, E.Nineties, E.Eighties, E.Ancient, E.NearFuture],
    },
    [M.Thailand]: {
        language: L.Thai, region: R.Thailand,
        genre: [G.Romance, G.Family, G.Revenge, G.Youth, G.Comedy, G.Folklore, G.Thriller, G.Fantasy],
        tone: [T.Romantic, T.Bittersweet, T.Light, T.Tense, T.Eerie, T.Warm],
        visualStyle: [S.Soft, S.Glossy, S.Natural, S.Cinematic, S.Noir],
        era: [E.Contemporary, E.Y2K, E.Nineties, E.Ancient, E.Mythic],
    },
    [M.Indonesia]: {
        language: L.Indonesian, region: R.Indonesia,
        genre: [G.Family, G.Romance, G.Revenge, G.ContractRomance, G.Underdog, G.Folklore, G.Thriller, G.Comedy],
        tone: [T.Moving, T.Bittersweet, T.Cathartic, T.Warm, T.Tense, T.Eerie],
        visualStyle: [S.Natural, S.Cinematic, S.Soft, S.Documentary, S.Noir],
        era: [E.Contemporary, E.Y2K, E.Nineties, E.MidCentury, E.Ancient, E.Mythic],
    },
    [M.Vietnam]: {
        language: L.Vietnamese, region: R.Vietnam,
        genre: [G.Family, G.Romance, G.Revenge, G.Underdog, G.RuralLife, G.Youth, G.Comedy, G.Suspense],
        tone: [T.Moving, T.Warm, T.Cathartic, T.Light, T.Sweet, T.Nostalgic],
        visualStyle: [S.Natural, S.Cinematic, S.Soft, S.Documentary, S.Retro],
        era: [E.Contemporary, E.Y2K, E.Nineties, E.Eighties, E.MidCentury, E.Ancient],
    },
    [M.Philippines]: {
        language: L.Filipino, region: R.Philippines,
        genre: [G.Romance, G.Family, G.Revenge, G.ContractRomance, G.Youth, G.Music, G.Comedy, G.Suspense],
        tone: [T.Romantic, T.Moving, T.Bittersweet, T.Sweet, T.Light, T.Cathartic],
        visualStyle: [S.Glossy, S.Natural, S.Soft, S.Cinematic, S.Retro],
        era: [E.Contemporary, E.Y2K, E.Nineties, E.MidCentury, E.Fictional],
    },
    [M.LatinAmerica]: {
        language: L.Spanish, region: R.LatinAmerica,
        genre: [G.Romance, G.Family, G.Revenge, G.SecondChance, G.ContractRomance, G.FemaleGrowth, G.Music, G.Crime, G.Comedy],
        tone: [T.Romantic, T.Bittersweet, T.Moving, T.Cathartic, T.Tense, T.Light],
        visualStyle: [S.Glossy, S.Cinematic, S.Natural, S.Retro, S.Noir],
        era: [E.Contemporary, E.Y2K, E.Nineties, E.MidCentury, E.Nineteenth, E.Fictional],
    },
    [M.Brazil]: {
        language: L.Portuguese, region: R.Brazil,
        genre: [G.Romance, G.Family, G.FemaleGrowth, G.Revenge, G.Comedy, G.Music, G.Youth, G.Crime],
        tone: [T.Moving, T.Romantic, T.Light, T.Cathartic, T.Bittersweet, T.Warm],
        visualStyle: [S.Natural, S.Glossy, S.Cinematic, S.Documentary, S.Retro],
        era: [E.Contemporary, E.Y2K, E.Nineties, E.MidCentury, E.Nineteenth],
    },
    [M.Europe]: {
        language: L.English, region: R.Europe,
        genre: [G.Romance, G.Suspense, G.Crime, G.Family, G.Thriller, G.FemaleGrowth, G.Comedy, G.Historical, G.RoyalRomance],
        tone: [T.Tense, T.Restrained, T.Romantic, T.Dark, T.Absurd, T.Moving],
        visualStyle: [S.Cinematic, S.Natural, S.Noir, S.Retro, S.Documentary, S.Gothic],
        era: [E.Contemporary, E.Nineties, E.Eighties, E.MidCentury, E.Nineteenth, E.Medieval, E.NearFuture],
    },
    [M.India]: {
        language: L.Hindi, region: R.India,
        genre: [G.Family, G.Romance, G.Revenge, G.Underdog, G.Fantasy, G.Music, G.Crime, G.Suspense],
        tone: [T.Moving, T.Cathartic, T.Romantic, T.Uplifting, T.Tense, T.Epic],
        visualStyle: [S.Glossy, S.Cinematic, S.Natural, S.Soft, S.Stylized],
        era: [E.Contemporary, E.Y2K, E.Nineties, E.Ancient, E.Mythic, E.Fictional],
    },
    [M.MiddleEast]: {
        language: L.Arabic, region: R.MiddleEast,
        genre: [G.Family, G.Romance, G.Suspense, G.FemaleGrowth, G.Underdog, G.Revenge, G.Comedy, G.Historical],
        tone: [T.Moving, T.Restrained, T.Tense, T.Warm, T.Cathartic, T.Romantic],
        visualStyle: [S.Natural, S.Cinematic, S.Glossy, S.Retro, S.Documentary],
        era: [E.Contemporary, E.Y2K, E.MidCentury, E.Early20th, E.Ancient, E.Fictional],
    },
    [M.Global]: {
        language: L.English, region: R.Fictional,
        genre: [G.Romance, G.Family, G.Suspense, G.FemaleGrowth, G.Comedy, G.Adventure, G.Fantasy, G.Scifi, G.Sports, G.Survival],
        tone: [T.Moving, T.Warm, T.Tense, T.Light, T.Uplifting, T.Romantic],
        visualStyle: [S.Cinematic, S.Natural, S.Soft, S.Stylized, S.Anime, S.Realistic3D],
        era: [E.Contemporary, E.Fictional, E.NearFuture, E.Ancient, E.Future, E.PostApocalyptic],
    },
};
