import React, { useCallback, useEffect, useRef, useState } from 'react';

// Small "ⓘ" trigger with a floating explanation card.
//
// The card is position: fixed with coordinates measured from the trigger, rather
// than absolutely positioned. Its natural home — the sidebar's scroll region —
// has both `overflow: hidden` and `overflow-y: auto` above it, which would clip
// an absolutely positioned card. Fixed positioning escapes both.

const CARD_WIDTH = 320;
const GAP = 6;

const InfoPopover = ({ title, label = 'More information', children }) => {
    const [open, setOpen] = useState(false);
    const [position, setPosition] = useState({ top: 0, left: 0 });
    const wrapRef = useRef(null);
    const triggerRef = useRef(null);

    const place = useCallback(() => {
        const trigger = triggerRef.current;
        if (!trigger) return;

        const rect = trigger.getBoundingClientRect();
        setPosition({
            top: rect.bottom + GAP,
            // Keep the card on screen when the trigger sits near the right edge.
            left: Math.max(8, Math.min(rect.left, window.innerWidth - CARD_WIDTH - 8)),
        });
    }, []);

    const toggle = () => {
        if (!open) place();
        setOpen((wasOpen) => !wasOpen);
    };

    useEffect(() => {
        if (!open) return;

        const onKeyDown = (event) => {
            if (event.key === 'Escape') setOpen(false);
        };
        // mousedown rather than click: the trigger's own click would otherwise
        // reopen the card in the same gesture that closed it.
        const onPointerDown = (event) => {
            if (!wrapRef.current?.contains(event.target)) setOpen(false);
        };

        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('mousedown', onPointerDown);
        window.addEventListener('resize', place);
        // The card is fixed, so it has to follow the trigger when anything scrolls.
        window.addEventListener('scroll', place, true);

        return () => {
            document.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('mousedown', onPointerDown);
            window.removeEventListener('resize', place);
            window.removeEventListener('scroll', place, true);
        };
    }, [open, place]);

    return (
        <span className='info-wrap' ref={wrapRef}>
            <button
                type='button'
                ref={triggerRef}
                className='info-trigger'
                aria-label={label}
                aria-expanded={open}
                onClick={toggle}
            >
                i
            </button>

            {open && (
                <div
                    className='info-card'
                    role='dialog'
                    aria-label={title}
                    style={{ top: position.top, left: position.left, width: CARD_WIDTH }}
                >
                    <div className='info-card-head'>
                        <strong>{title}</strong>
                        <button
                            type='button'
                            className='info-close'
                            aria-label='Close'
                            onClick={() => setOpen(false)}
                        >
                            ✕
                        </button>
                    </div>
                    <div className='info-card-body'>{children}</div>
                </div>
            )}
        </span>
    );
};

export default InfoPopover;
