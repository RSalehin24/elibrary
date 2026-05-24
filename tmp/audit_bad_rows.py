"""Audit which bad contributor names current rules still accept."""
from apps.catalog.models import ContributorRole
from apps.ingestion.services.normalization_support.metadata import looks_like_contributor_name

BAD_SAMPLES = {
    ContributorRole.AUTHOR: [
        "২ ছোটগল্প", "১৪৩২ পূজাবার্ষিকী -(থ্রিলার পত্রিকা)",
        "১০", "১৩১২)", "১৯১৮)", "২", "৩", "৪",
        "১ (প্রবন্ধ সংকলন)", "২৫১০)", "৩০৯০)", "৩৭৪৫)",
        "৪৩৩০)", "৪৮৭৪)", "৪৯৬)", "৫৯৬৯)", "৭০৫৩)",
    ],
    ContributorRole.TRANSLATOR: [
        "ও সম্পাদনা – ফারুক হোসেন", "প্রসঙ্গে", "ঢাকা",
        "দুর্গাদাস লাহিড়ী)", "মাকসুদুজ্জামান খান প্রথম প্রকাশ : জুন ২০০৫",
        "Bangladesh", "Dhaka 1215", "Horror", "Short Stories",
        "by Bruce Walter", "of Lust For Life by Irving Stone",
        "and elaborate purports", "উৎসর্গ", "উৎসর্গ শিল্পী শাহাবুদ্দিন",
        "• সম্পাদনা • ভূমিকা মুহম্মদ জালালউদ্দীন বিশ্বাস",
        "বিভাগীয় প্রধান ইসলামিক স্টাডিজ বিভাগ",
        "১৪১৯ জানুয়ারী", "১৯৭১", "২০১৩",
        "‘‘ জিজ্ঞেস করছে", "“আমি বই পড়ি",
        "কলিকাতা", "কোথায় যাচ্ছা", "বহুল পঠিত উপন্যাস", "বই বেরোচ্ছে",
        "Ian Johnston) Published: 1912 Categorie(s): Fiction",
        "of SATYARTH PRAKASH written by SWAMI DAYANAND SARASWATI",
        "and elaborate purports",
        "ও সম্পাদনা", "ও সম্পাদনা: জাকির হোসেন",
        "ও সংকলন বিভাগ (সদস্য সচিব)",
        "কবিতা – রবীন্দ্রনাথ ঠাকুর", "কবিতা – হুমায়ুন আজাদ",
        "করতে পারি", "করব", "করল টোনগানে",
        "করলে এইরকম দাঁড়ায়–", "করিয়ে ট্র্যান্সক্রিপ্ট নেবেন",
        "করে শহীদকে জানালো", "করেছিলেন",
        "কৌশিক জামান / প্রথম প্রকাশ : ফেব্রুয়ারি ২০১৮",
        "এপ্রিল ১৯৯২ প্রচ্ছদ : পূর্ণেন্দু পত্রী",
        "এবং ভিক্টিমের বান্ধবী",
        "ও নাট্যরূপ : রাফিক হারিরি",
        "ও ব্যাখ্যা সহ", "ও সম্পাদনা",
        "কী ইতিহাসের পাতা থেকে মণিমুক্তো তুলে আনাই হোক",
        "কে তোমরা",
        "মে ১৯৯৫ প্রচ্ছদ : পূর্ণেন্দু পত্রী",
        "যে বইয়ের অনুবাদক হিসেবে আমার নাম যাবে",
        "সম্পর্কে", "সরকারি শহীদ সোহরাওয়ার্দী কলেজ",
        "সহযোগী – পপি আখতার",
        "সাহিত্য হোক",
        "২০২১ প্রচ্ছদ: সজল চৌধুরী",
        "ঢাকা ডিসেম্বর ১৯৬৪",
        "জানুয়ারি ১৯৯৪ প্রচ্ছদ : পূর্ণেন্দু পত্রী",
        "Sigma",  # ambiguous
        "Kabir Chand",  # actually a name, fine
        "মো: রিয়াজ উদ্দিন খান",
    ],
    ContributorRole.EDITOR: [
        "গপ্পো-সপ্পো)", "অধ্যাপক", "কলকাতা – ৭০০০২৮",
        "কি জানলাম আমি", "সম্পাদনায়",
        "১৬ ফেব্রুয়ারি", "২০২০", "ফেব্রুয়ারি ২০১৭", "ফেব্রুয়ারি ২০২১",
        "মিস্টার ম্যাকারডল তো জানতে চাইবেন",
        "ঢাকা তারিখ ১লা এপ্রিল ১৯৯৮",
        "রোর বাংলা ২৪ জানুয়ারি",
        "যে শেষ পর্যন্ত লেখাটা ছেপেছেন",
        "প্রধান শিক্ষক আবদুল হামিদ",
        "সংস্কৃতি বিভাগ ঢাকা বিশ্ববিদ্যালয়",
        "তা যদি না বলি", "থেকে শুরু করে বড় সাহেব",
        "সব রহস্যের কিনারা করে ফেলেছেন নাকি",
        "সাহেব উত্তেজিতভাবে জিজ্ঞেস করলেন",
        "‘ভ্রমণ’ কলকাতা জানুয়ারি ১৯৯৮",
        "ইসলামের ইতিহাস", "ও কবি", "পরিচিতি", "কিতাব পরিমার্জন",
        "মৃনাল চক্রবর্তী (ইনবক্স অফিসিয়াল)",
        "শুভম ভট্টাচার্য্য (তোমার বই)",
        "শ্রীপঞ্চানন তর্করত্ন ভট্টপল্লী (ভাটপাড়া)",
        "২৩/০৭/২০২১", "২০২৩ আকুয়া",
    ],
}

# names that SHOULD still be accepted (regression guard)
GOOD_SAMPLES = {
    ContributorRole.AUTHOR: ["রকিব হাসান", "মোহাম্মদ নাজিম উদ্দিন", "George Orwell"],
    ContributorRole.TRANSLATOR: ["অনীশ দাস অপু", "সালমান হক", "মাহমুদ মেনন", "শওকত হোসেন"],
    ContributorRole.EDITOR: ["সমীর মৈত্র", "সাগরময় ঘোষ", "ব্রজেন্দ্রনাথ বন্দ্যোপাধ্যায়"],
    ContributorRole.PUBLISHER: ["সেবা প্রকাশনী", "ঐতিহ্য", "প্রথমা", "Patra Bharati"],
}

print("=== Bad samples — should be rejected ===")
total_bad = 0
surviving = []
for role, samples in BAD_SAMPLES.items():
    for s in samples:
        total_bad += 1
        if looks_like_contributor_name(s, role=role):
            surviving.append((role, s))
print(f"Total bad: {total_bad}")
print(f"Correctly rejected: {total_bad - len(surviving)}")
print(f"Still ACCEPTED (need new rules): {len(surviving)}")
for role, s in surviving:
    print(f"  [{role}] {s!r}")

print("\n=== Good samples — should still be accepted ===")
total_good = 0
broken = []
for role, samples in GOOD_SAMPLES.items():
    for s in samples:
        total_good += 1
        if not looks_like_contributor_name(s, role=role):
            broken.append((role, s))
print(f"Total good: {total_good}")
print(f"Correctly accepted: {total_good - len(broken)}")
print(f"Wrongly REJECTED (regressions): {len(broken)}")
for role, s in broken:
    print(f"  [{role}] {s!r}")
