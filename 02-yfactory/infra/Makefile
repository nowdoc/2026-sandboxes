Y := sudo ./yfactory.sh

.PHONY: help init up down restart deploy status logs runs new shell publish rm

help:
	@./yfactory.sh help

init up down status runs:
	$(Y) $@

deploy:
	$(Y) deploy $(V) $(VM)

logs:
	$(Y) logs $(S)

restart:
	$(Y) restart $(S)

new:
	$(Y) new $(REPO) "$(PROMPT)"

shell publish rm:
	$(Y) $@ $(ID)
