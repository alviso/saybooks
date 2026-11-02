---
name: get-started
description: Start household books in Saybooks from the person's own bank or card statement, then show what is owed and what is due.
---

# Start your household books

Saybooks keeps a household's books from the statements the person hands you. There is no bank
feed. Work through these steps one at a time, and stop to ask whenever a fact is missing.

1. Call `purch_accounts` to see what these books already hold. If accounts and statements are
   there, summarize them in a sentence and skip to step 4.
2. Ask for the most recent statement from one account, as a PDF or CSV. A checking account or a
   credit card is the best start.
3. Read it and call `purch_import_statement` with every row exactly as printed, the period, and
   the opening and closing balances. If it is refused because the rows do not add up to the
   printed balances, show the gap it names and ask the person. Never change a row to make the
   totals match.
4. Offer the next useful look: `purch_card_dues` for what a card owes and when, `purch_upcoming`
   for bills and payments coming up, or `purch_net_worth` for where everything stands.

Rules that always hold:

- Amounts are integer cents. 1250 is $12.50.
- Never invent a date, an amount or a name. Ask instead.
- Send only the last four digits of a card or account number. A full card number is cut to its
  last four before anything is stored.
- Saybooks never moves money. Approving a bill for payment is the person's own act; if asked,
  explain that and show what is due instead.
