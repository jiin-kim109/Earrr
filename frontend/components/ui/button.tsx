import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import { cn } from 'cn';
import { Slot } from 'radix-ui';

import * as React from 'react';

const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer touch-manipulation items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-[background-color,color,box-shadow,transform] duration-200 ease-out-expo motion-safe:active:scale-[0.98] motion-reduce:transform-none motion-reduce:transition-none outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive:
          'bg-destructive text-primary-foreground hover:bg-destructive/90 focus-visible:ring-destructive/20',
        outline:
          'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        text: 'bg-transparent font-normal text-muted-foreground hover:text-foreground focus-visible:bg-accent focus-visible:ring-0',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-11 px-5 py-2 has-[>svg]:px-4',
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-9 gap-1.5 rounded-md px-3 pointer-coarse:min-h-11 has-[>svg]:px-2.5',
        lg: 'h-12 rounded-md px-6 has-[>svg]:px-5',
        icon: 'size-11',
        'icon-xs': "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-9 pointer-coarse:min-h-11 pointer-coarse:min-w-11',
        'icon-lg': 'size-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : 'button';

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(
        buttonVariants({ variant, size }),
        size?.startsWith('icon') &&
          (variant === 'default'
            ? 'focus-visible:ring-0 focus-visible:brightness-125'
            : 'focus-visible:ring-0 focus-visible:border-transparent focus-visible:bg-accent'),
        className,
      )}
      {...props}
    />
  );
}

export { Button, buttonVariants };
