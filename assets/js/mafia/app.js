(function () {
            const album = document.getElementById('album');
            const btn = document.getElementById('toggleBtn');
            const modal = document.getElementById('modal');
            const modalImg = document.getElementById('modalImg');
            const modalTitle = document.getElementById('modalTitle');
            const modalRole = document.getElementById('modalRole');
            const modalDesc = document.getElementById('modalDesc');
            const modalClose = document.getElementById('modalClose');

            function setOpen(open) {
                album.classList.toggle('open', open);
                btn.textContent = open ? 'Закрыть архив' : 'Открыть архив';
                btn.setAttribute('aria-expanded', open ? 'true' : 'false');
            }

            btn.addEventListener('click', function () {
                setOpen(!album.classList.contains('open'));
            });

            function openModal(card) {
                const img = card.querySelector('img');
                if (!img) return;
                modalImg.src = img.getAttribute('src');
                modalImg.alt = img.getAttribute('alt') || '';
                modalTitle.textContent = card.dataset.name || '';
                modalRole.textContent = card.dataset.role ? card.dataset.role : '';
                modalDesc.textContent = card.dataset.desc || '';
                modal.hidden = false;
                requestAnimationFrame(function () {
                    modal.classList.add('is-open');
                });
                document.body.style.overflow = 'hidden';
            }

            function closeModal() {
                modal.classList.remove('is-open');
                document.body.style.overflow = '';
                setTimeout(function () {
                    modal.hidden = true;
                    modalImg.removeAttribute('src');
                }, 400);
            }

            modalClose.addEventListener('click', closeModal);
            modal.addEventListener('click', function (e) {
                if (e.target === modal) closeModal();
            });
            document.addEventListener('keydown', function (e) {
                if (e.key === 'Escape' && modal.classList.contains('is-open')) closeModal();
            });

            album.querySelectorAll('.photo-card').forEach(function (card) {
                card.addEventListener('click', function (e) {
                    if (!album.classList.contains('open')) return;
                    e.stopPropagation();
                    openModal(card);
                });
                card.addEventListener('keydown', function (e) {
                    if (!album.classList.contains('open')) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openModal(card);
                    }
                });
            });
        })();
